import { execFileSync } from 'child_process';
import fs from 'fs';

const ENV_BLOCK_LIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

/** Verify that a command exists in PATH. Throws a descriptive error if not found. */
export function validateCommand(command: string): void {
  if (!command || !command.trim()) {
    throw new Error('Command must not be empty.');
  }
  if (command.startsWith('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return;
    } catch {
      throw new Error(
        `Command '${command}' not found or not executable. Check that it is installed.`,
      );
    }
  }
  try {
    execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 });
  } catch {
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}

export function resolveCommandPath(command: string): string {
  if (command.startsWith('/')) return command;
  const out = execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 }).trim();
  if (!out) throw new Error(`Command '${command}' not found in PATH.`);
  return out;
}

export function normalizeCwd(cwd: string): string {
  if (!cwd) return process.env.HOME || '/';
  if (!fs.existsSync(cwd)) return process.env.HOME || '/';
  return cwd;
}

export function buildSpawnEnv(env: Record<string, string>): Record<string, string> {
  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }

  const safeEnvOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_BLOCK_LIST.has(k)) safeEnvOverrides[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...filteredEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...safeEnvOverrides,
  };

  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  return spawnEnv;
}

export function sanitizeSpawnCommand(command: string): void {
  if (/[;&|`$(){}\n]/.test(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }
}

export function shellEscapeArg(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
