import { Worker } from 'worker_threads';

let worker: Worker | null = null;
let workerStarting = false;
let nextReqId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ensureWorker(): Promise<void> {
  if (worker) return Promise.resolve();
  if (workerStarting) {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (!workerStarting && worker) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
  }

  workerStarting = true;
  return new Promise((resolve, reject) => {
    try {
      worker = new Worker(new URL('./git-worker.js', import.meta.url));
      worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error ?? 'git worker command failed'));
      });
      worker.on('exit', (code) => {
        worker = null;
        workerStarting = false;
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error(`git worker exited (code ${code})`));
        }
      });
      worker.on('error', (err) => {
        console.error('[git-worker] error', err);
      });
      workerStarting = false;
      resolve();
    } catch (err) {
      workerStarting = false;
      reject(err);
    }
  });
}

async function callGit<T>(cmd: string, payload?: unknown): Promise<T> {
  await ensureWorker();
  if (!worker) throw new Error('git worker unavailable');
  const id = nextReqId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker?.postMessage({ id, cmd, payload });
  });
}

export function getGitIgnoredDirs(projectRoot: string): Promise<string[]> {
  return callGit('getGitIgnoredDirs', { projectRoot });
}

export function getMainBranch(projectRoot: string): Promise<string> {
  return callGit('getMainBranch', { projectRoot });
}

export function getCurrentBranch(projectRoot: string): Promise<string> {
  return callGit('getCurrentBranch', { projectRoot });
}

export function getChangedFiles(worktreePath: string): Promise<unknown> {
  return callGit('getChangedFiles', { worktreePath });
}

export function getChangedFilesFromBranch(
  projectRoot: string,
  branchName: string,
): Promise<unknown> {
  return callGit('getChangedFilesFromBranch', { projectRoot, branchName });
}

export function getFileDiff(worktreePath: string, filePath: string): Promise<unknown> {
  return callGit('getFileDiff', { worktreePath, filePath });
}

export function getFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
): Promise<unknown> {
  return callGit('getFileDiffFromBranch', { projectRoot, branchName, filePath });
}

export function getWorktreeStatus(worktreePath: string): Promise<unknown> {
  return callGit('getWorktreeStatus', { worktreePath });
}

export function commitAll(worktreePath: string, message: string): Promise<unknown> {
  return callGit('commitAll', { worktreePath, message });
}

export function discardUncommitted(worktreePath: string): Promise<unknown> {
  return callGit('discardUncommitted', { worktreePath });
}

export function checkMergeStatus(worktreePath: string): Promise<unknown> {
  return callGit('checkMergeStatus', { worktreePath });
}

export function mergeTask(
  projectRoot: string,
  branchName: string,
  squash: boolean,
  message?: string,
  cleanup?: boolean,
): Promise<unknown> {
  return callGit('mergeTask', { projectRoot, branchName, squash, message, cleanup });
}

export function getBranchLog(worktreePath: string): Promise<unknown> {
  return callGit('getBranchLog', { worktreePath });
}

export function pushTask(projectRoot: string, branchName: string): Promise<unknown> {
  return callGit('pushTask', { projectRoot, branchName });
}

export function rebaseTask(worktreePath: string): Promise<unknown> {
  return callGit('rebaseTask', { worktreePath });
}

export function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[],
  forceClean = false,
): Promise<{ path: string; branch: string }> {
  return callGit('createWorktree', { repoRoot, branchName, symlinkDirs, forceClean });
}

export function removeWorktree(
  repoRoot: string,
  branchName: string,
  deleteBranch: boolean,
): Promise<void> {
  return callGit('removeWorktree', { repoRoot, branchName, deleteBranch });
}
