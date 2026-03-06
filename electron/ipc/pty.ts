import * as pty from 'node-pty';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BrowserWindow, MessagePortMain } from 'electron';
import { RingBuffer } from '../remote/ring-buffer.js';
import {
  validateCommand,
  buildSpawnEnv,
  sanitizeSpawnCommand,
  shellEscapeArg,
  resolveCommandPath,
  normalizeCwd,
} from './terminal-common.js';

const exec = promisify(execFile);

type PtyEventType = 'spawn' | 'exit' | 'list-changed';
type PtyEventListener = (agentId: string, data?: unknown) => void;
const eventListeners = new Map<PtyEventType, Set<PtyEventListener>>();

interface MainSession {
  proc: pty.IPty;
  channelId: string;
  taskId: string;
  agentId: string;
  isShell: boolean;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  cols: number;
  runtime: 'tmux';
  runtimeSessionId: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  streamPort: MessagePortMain | null;
}

const sessions = new Map<string, MainSession>();
const pendingStreamPorts = new Map<string, MessagePortMain>();

const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 8;
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;
let tmuxPathCache: string | null = null;

function ensureTmuxPath(): string {
  if (tmuxPathCache) return tmuxPathCache;
  validateCommand('tmux');
  tmuxPathCache = resolveCommandPath('tmux');
  return tmuxPathCache;
}

function sessionNameFor(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `pc_${safe || 'agent'}`;
}

/** Register a listener for PTY lifecycle events. Returns an unsubscribe function. */
export function onPtyEvent(event: PtyEventType, listener: PtyEventListener): () => void {
  let listeners = eventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(event, listeners);
  }
  listeners.add(listener);
  return () => {
    eventListeners.get(event)?.delete(listener);
  };
}

function emitPtyEvent(event: PtyEventType, agentId: string, data?: unknown): void {
  eventListeners.get(event)?.forEach((fn) => fn(agentId, data));
}

/** Notify listeners that the agent list has changed (e.g. task deleted). */
export function notifyAgentListChanged(): void {
  emitPtyEvent('list-changed', '');
}

export function attachAgentStream(agentId: string, port: MessagePortMain): void {
  const previous = pendingStreamPorts.get(agentId);
  if (previous && previous !== port) {
    try {
      previous.close();
    } catch {
      // ignore
    }
  }

  const active = sessions.get(agentId);
  if (active) {
    try {
      active.streamPort?.close();
    } catch {
      // ignore
    }
    active.streamPort = port;
  } else {
    pendingStreamPorts.set(agentId, port);
  }

  port.on('close', () => {
    const s = sessions.get(agentId);
    if (s?.streamPort === port) s.streamPort = null;
    if (pendingStreamPorts.get(agentId) === port) pendingStreamPorts.delete(agentId);
  });
  port.start();
}

async function killTmuxSession(sessionId: string): Promise<void> {
  const tmuxPath = ensureTmuxPath();
  await exec(tmuxPath, ['kill-session', '-t', sessionId]).catch(() => {});
}

export async function spawnAgent(
  win: BrowserWindow,
  args: {
    taskId: string;
    agentId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    isShell?: boolean;
    onOutput: { __CHANNEL_ID__: string };
  },
): Promise<void> {
  const channelId = args.onOutput.__CHANNEL_ID__;
  const command = args.command || process.env.SHELL || '/bin/sh';
  const cwd = normalizeCwd(args.cwd || process.env.HOME || '/');
  const tmuxPath = ensureTmuxPath();

  sanitizeSpawnCommand(command);
  validateCommand(command);
  const resolvedCommand = resolveCommandPath(command);

  const existing = sessions.get(args.agentId);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.subscribers.clear();
    await killTmuxSession(existing.runtimeSessionId);
    existing.proc.kill();
    sessions.delete(args.agentId);
  }

  const spawnEnv = buildSpawnEnv(args.env ?? {});
  const tmuxSessionId = sessionNameFor(args.agentId);
  const shellCmd = [resolvedCommand, ...(args.args ?? [])].map((v) => shellEscapeArg(v)).join(' ');

  let proc: pty.IPty;
  try {
    proc = pty.spawn(
      tmuxPath,
      ['new-session', '-A', '-D', '-s', tmuxSessionId, '-c', cwd, shellCmd],
      {
        name: 'xterm-256color',
        cols: args.cols,
        rows: args.rows,
        cwd,
        env: spawnEnv,
      },
    );
  } catch (err) {
    throw new Error(`Failed to spawn tmux session '${tmuxSessionId}': ${String(err)}`);
  }

  const session: MainSession = {
    proc,
    channelId,
    taskId: args.taskId,
    agentId: args.agentId,
    isShell: args.isShell ?? false,
    subscribers: new Set(),
    scrollback: new RingBuffer(),
    cols: proc.cols,
    runtime: 'tmux',
    runtimeSessionId: tmuxSessionId,
    flushTimer: null,
    streamPort: pendingStreamPorts.get(args.agentId) ?? null,
  };
  pendingStreamPorts.delete(args.agentId);
  sessions.set(args.agentId, session);

  let batchChunks: Buffer[] = [];
  let batchBytes = 0;
  const tailChunks: Buffer[] = [];
  let tailBytes = 0;

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  const sendData = (chunk: Buffer) => {
    if (session.streamPort) {
      try {
        const view = new Uint8Array(chunk);
        session.streamPort.postMessage({ type: 'Data', data: view });
        return;
      } catch {
        session.streamPort = null;
      }
    }
    send({ type: 'Data', data: chunk });
  };

  const flush = () => {
    if (batchBytes === 0) return;
    const merged =
      batchChunks.length === 1 ? batchChunks[0] : Buffer.concat(batchChunks, batchBytes);
    sendData(merged);
    session.scrollback.write(merged);
    if (session.subscribers.size > 0) {
      const encoded = merged.toString('base64');
      for (const sub of session.subscribers) {
        sub(encoded);
      }
    }
    batchChunks = [];
    batchBytes = 0;
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  };

  proc.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8');

    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > TAIL_CAP && tailChunks.length > 0) {
      const first = tailChunks[0];
      if (tailBytes - first.length >= TAIL_CAP) {
        tailChunks.shift();
        tailBytes -= first.length;
        continue;
      }
      const drop = tailBytes - TAIL_CAP;
      tailChunks[0] = first.subarray(drop);
      tailBytes -= drop;
      break;
    }

    batchChunks.push(chunk);
    batchBytes += chunk.length;

    if (batchBytes >= BATCH_MAX) {
      flush();
      return;
    }

    if (chunk.length < 1024) {
      flush();
      return;
    }

    if (!session.flushTimer) {
      session.flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    if (sessions.get(args.agentId) !== session) return;

    flush();

    const tailBuf =
      tailChunks.length === 0
        ? Buffer.alloc(0)
        : tailChunks.length === 1
          ? tailChunks[0]
          : Buffer.concat(tailChunks, tailBytes);
    const tailStr = tailBuf.toString('utf8');
    const lines = tailStr
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);

    send({
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, { exitCode, signal });
    sessions.delete(args.agentId);
  });

  emitPtyEvent('spawn', args.agentId);
}

export async function writeToAgent(agentId: string, data: string): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.write(data);
}

export async function resizeAgent(agentId: string, cols: number, rows: number): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;
  session.cols = cols;
  session.proc.resize(cols, rows);
}

export async function pauseAgent(agentId: string): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;
  session.proc.pause();
}

export async function resumeAgent(agentId: string): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;
  session.proc.resume();
}

export async function killAgent(agentId: string): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  session.subscribers.clear();
  try {
    session.streamPort?.close();
  } catch {
    // ignore
  }
  pendingStreamPorts.delete(agentId);
  await killTmuxSession(session.runtimeSessionId);
  session.proc.kill();
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const [, session] of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.subscribers.clear();
    try {
      session.streamPort?.close();
    } catch {
      // ignore
    }
    void killTmuxSession(session.runtimeSessionId);
    session.proc.kill();
  }
  pendingStreamPorts.clear();
}

/** Subscribe to live base64-encoded output from an agent. */
export function subscribeToAgent(agentId: string, cb: (encoded: string) => void): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.subscribers.add(cb);
  return true;
}

/** Remove a previously registered output subscriber. */
export function unsubscribeFromAgent(agentId: string, cb: (encoded: string) => void): void {
  sessions.get(agentId)?.subscribers.delete(cb);
}

/** Get the scrollback buffer for an agent as a base64 string. */
export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

/** Return all active agent IDs. */
export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

/** Return metadata for a specific agent, or null if not found. */
export function getAgentMeta(agentId: string): {
  taskId: string;
  agentId: string;
  isShell: boolean;
  runtime: 'tmux';
  runtimeSessionId: string;
} | null {
  const s = sessions.get(agentId);
  return s
    ? {
        taskId: s.taskId,
        agentId: s.agentId,
        isShell: s.isShell,
        runtime: s.runtime,
        runtimeSessionId: s.runtimeSessionId,
      }
    : null;
}

/** Return the current column width of an agent's PTY. */
export function getAgentCols(agentId: string): number {
  const s = sessions.get(agentId);
  return s ? s.cols : 80;
}

export { validateCommand };
