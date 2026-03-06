import * as pty from 'node-pty';
import { parentPort } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  validateCommand,
  buildSpawnEnv,
  sanitizeSpawnCommand,
  shellEscapeArg,
  resolveCommandPath,
  normalizeCwd,
} from './terminal-common.js';

const exec = promisify(execFile);

interface SpawnArgs {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  isShell?: boolean;
}

type RuntimeType = 'tmux' | 'pty';

interface WorkerSession {
  proc: pty.IPty;
  runtime: RuntimeType;
  tmuxSessionId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  batchChunks: Buffer[];
  batchBytes: number;
  tailChunks: Buffer[];
  tailBytes: number;
}

interface WorkerRequest {
  id: number;
  cmd: 'spawn' | 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'killAll' | 'getCols';
  payload?: unknown;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const sessions = new Map<string, WorkerSession>();
const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 8;
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;
let tmuxAvailableCache: boolean | null = null;
let tmuxPathCache: string | null = null;

function postEvent(event: unknown) {
  parentPort?.postMessage({ type: 'event', event });
}

function postResponse(res: WorkerResponse) {
  parentPort?.postMessage({ type: 'response', ...res });
}

function hasTmux(): boolean {
  if (tmuxAvailableCache !== null) return tmuxAvailableCache;
  try {
    validateCommand('tmux');
    tmuxPathCache = resolveCommandPath('tmux');
    tmuxAvailableCache = true;
  } catch {
    tmuxPathCache = null;
    tmuxAvailableCache = false;
  }
  return tmuxAvailableCache;
}

function sessionNameFor(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `pc_${safe || 'agent'}`;
}

function flush(agentId: string, session: WorkerSession): void {
  if (session.batchBytes === 0) return;
  const merged =
    session.batchChunks.length === 1
      ? session.batchChunks[0]
      : Buffer.concat(session.batchChunks, session.batchBytes);
  session.batchChunks = [];
  session.batchBytes = 0;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }

  const view = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  postEvent({ type: 'data', agentId, data: view });
}

function onData(agentId: string, session: WorkerSession, data: string): void {
  const chunk = Buffer.from(data, 'utf8');

  session.tailChunks.push(chunk);
  session.tailBytes += chunk.length;
  while (session.tailBytes > TAIL_CAP && session.tailChunks.length > 0) {
    const first = session.tailChunks[0];
    if (session.tailBytes - first.length >= TAIL_CAP) {
      session.tailChunks.shift();
      session.tailBytes -= first.length;
      continue;
    }
    const drop = session.tailBytes - TAIL_CAP;
    session.tailChunks[0] = first.subarray(drop);
    session.tailBytes -= drop;
    break;
  }

  session.batchChunks.push(chunk);
  session.batchBytes += chunk.length;

  if (session.batchBytes >= BATCH_MAX) {
    flush(agentId, session);
    return;
  }

  if (chunk.length < 1024) {
    flush(agentId, session);
    return;
  }

  if (!session.flushTimer) {
    session.flushTimer = setTimeout(() => flush(agentId, session), BATCH_INTERVAL);
  }
}

function finalizeExit(
  agentId: string,
  session: WorkerSession,
  exitCode: number | undefined,
  signal: number | undefined,
): void {
  flush(agentId, session);
  const tailBuf =
    session.tailChunks.length === 0
      ? Buffer.alloc(0)
      : session.tailChunks.length === 1
        ? session.tailChunks[0]
        : Buffer.concat(session.tailChunks, session.tailBytes);
  const tailStr = tailBuf.toString('utf8');
  const lines = tailStr
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
    .slice(-MAX_LINES);

  sessions.delete(agentId);
  postEvent({
    type: 'exit',
    agentId,
    exitCode: exitCode ?? null,
    signal: signal !== undefined ? String(signal) : null,
    lastOutput: lines,
  });
}

function spawnPty(args: SpawnArgs): {
  proc: pty.IPty;
  runtime: RuntimeType;
  tmuxSessionId: string | null;
} {
  const command = args.command || process.env.SHELL || '/bin/sh';
  const cwd = normalizeCwd(args.cwd || process.env.HOME || '/');
  sanitizeSpawnCommand(command);
  validateCommand(command);
  const resolvedCommand = resolveCommandPath(command);

  const spawnEnv = buildSpawnEnv(args.env ?? {});

  if (!hasTmux() || !tmuxPathCache) {
    throw new Error('tmux is required but not available in PATH.');
  }

  const tmuxSessionId = sessionNameFor(args.agentId);
  const shellCmd = [resolvedCommand, ...(args.args ?? [])].map((v) => shellEscapeArg(v)).join(' ');
  try {
    const proc = pty.spawn(
      tmuxPathCache,
      ['new-session', '-A', '-D', '-s', tmuxSessionId, '-c', cwd, shellCmd],
      {
        name: 'xterm-256color',
        cols: args.cols,
        rows: args.rows,
        cwd,
        env: spawnEnv,
      },
    );
    return { proc, runtime: 'tmux', tmuxSessionId };
  } catch (err) {
    throw new Error(`Failed to spawn tmux session '${tmuxSessionId}': ${String(err)}`);
  }
}

async function killRuntimeSession(session: WorkerSession): Promise<void> {
  if (session.runtime === 'tmux' && session.tmuxSessionId) {
    await exec('tmux', ['kill-session', '-t', session.tmuxSessionId]).catch(() => {});
  }
  session.proc.kill();
}

async function handleRequest(msg: WorkerRequest): Promise<void> {
  try {
    switch (msg.cmd) {
      case 'spawn': {
        const args = msg.payload as SpawnArgs;

        const existing = sessions.get(args.agentId);
        if (existing) {
          if (existing.flushTimer) {
            clearTimeout(existing.flushTimer);
            existing.flushTimer = null;
          }
          await killRuntimeSession(existing).catch(() => {});
          sessions.delete(args.agentId);
        }

        const spawned = spawnPty(args);
        const session: WorkerSession = {
          proc: spawned.proc,
          runtime: spawned.runtime,
          tmuxSessionId: spawned.tmuxSessionId,
          flushTimer: null,
          batchChunks: [],
          batchBytes: 0,
          tailChunks: [],
          tailBytes: 0,
        };
        sessions.set(args.agentId, session);

        spawned.proc.onData((data) => onData(args.agentId, session, data));
        spawned.proc.onExit(({ exitCode, signal }) => {
          const cur = sessions.get(args.agentId);
          if (cur !== session) return;
          finalizeExit(args.agentId, session, exitCode, signal);
        });

        postResponse({
          id: msg.id,
          ok: true,
          result: {
            runtime: spawned.runtime,
            sessionId: spawned.tmuxSessionId,
            cols: spawned.proc.cols,
          },
        });
        return;
      }
      case 'write': {
        const { agentId, data } = msg.payload as { agentId: string; data: string };
        const session = sessions.get(agentId);
        if (!session) throw new Error(`Agent not found: ${agentId}`);
        session.proc.write(data);
        postResponse({ id: msg.id, ok: true });
        return;
      }
      case 'resize': {
        const { agentId, cols, rows } = msg.payload as {
          agentId: string;
          cols: number;
          rows: number;
        };
        const session = sessions.get(agentId);
        if (!session) throw new Error(`Agent not found: ${agentId}`);
        session.proc.resize(cols, rows);
        postResponse({ id: msg.id, ok: true });
        return;
      }
      case 'pause': {
        const { agentId } = msg.payload as { agentId: string };
        const session = sessions.get(agentId);
        if (!session) throw new Error(`Agent not found: ${agentId}`);
        session.proc.pause();
        postResponse({ id: msg.id, ok: true });
        return;
      }
      case 'resume': {
        const { agentId } = msg.payload as { agentId: string };
        const session = sessions.get(agentId);
        if (!session) throw new Error(`Agent not found: ${agentId}`);
        session.proc.resume();
        postResponse({ id: msg.id, ok: true });
        return;
      }
      case 'kill': {
        const { agentId } = msg.payload as { agentId: string };
        const session = sessions.get(agentId);
        if (session) {
          if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = null;
          }
          await killRuntimeSession(session).catch(() => {});
        }
        postResponse({ id: msg.id, ok: true });
        return;
      }
      case 'killAll': {
        for (const session of sessions.values()) {
          if (session.flushTimer) clearTimeout(session.flushTimer);
          await killRuntimeSession(session).catch(() => {});
        }
        postResponse({ id: msg.id, ok: true });
        return;
      }
      case 'getCols': {
        const { agentId } = msg.payload as { agentId: string };
        const session = sessions.get(agentId);
        postResponse({ id: msg.id, ok: true, result: session?.proc.cols ?? 80 });
        return;
      }
      default:
        throw new Error('Unknown worker command');
    }
  } catch (err) {
    postResponse({ id: msg.id, ok: false, error: String(err) });
  }
}

parentPort?.on('message', (msg: WorkerRequest) => {
  void handleRequest(msg);
});
