import { parentPort } from 'worker_threads';
import {
  getGitIgnoredDirs,
  getMainBranch,
  getCurrentBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getWorktreeStatus,
  commitAll,
  discardUncommitted,
  checkMergeStatus,
  mergeTask,
  getBranchLog,
  pushTask,
  rebaseTask,
  createWorktree,
  removeWorktree,
} from './git.js';

interface Req {
  id: number;
  cmd: string;
  payload?: unknown;
}

function respond(id: number, ok: boolean, result?: unknown, error?: string): void {
  parentPort?.postMessage({ id, ok, result, error });
}

async function handle(req: Req): Promise<void> {
  try {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.cmd) {
      case 'getGitIgnoredDirs':
        respond(req.id, true, await getGitIgnoredDirs(p.projectRoot as string));
        return;
      case 'getMainBranch':
        respond(req.id, true, await getMainBranch(p.projectRoot as string));
        return;
      case 'getCurrentBranch':
        respond(req.id, true, await getCurrentBranch(p.projectRoot as string));
        return;
      case 'getChangedFiles':
        respond(req.id, true, await getChangedFiles(p.worktreePath as string));
        return;
      case 'getChangedFilesFromBranch':
        respond(
          req.id,
          true,
          await getChangedFilesFromBranch(p.projectRoot as string, p.branchName as string),
        );
        return;
      case 'getFileDiff':
        respond(req.id, true, await getFileDiff(p.worktreePath as string, p.filePath as string));
        return;
      case 'getFileDiffFromBranch':
        respond(
          req.id,
          true,
          await getFileDiffFromBranch(
            p.projectRoot as string,
            p.branchName as string,
            p.filePath as string,
          ),
        );
        return;
      case 'getWorktreeStatus':
        respond(req.id, true, await getWorktreeStatus(p.worktreePath as string));
        return;
      case 'commitAll':
        respond(req.id, true, await commitAll(p.worktreePath as string, p.message as string));
        return;
      case 'discardUncommitted':
        respond(req.id, true, await discardUncommitted(p.worktreePath as string));
        return;
      case 'checkMergeStatus':
        respond(req.id, true, await checkMergeStatus(p.worktreePath as string));
        return;
      case 'mergeTask':
        respond(
          req.id,
          true,
          await mergeTask(
            p.projectRoot as string,
            p.branchName as string,
            Boolean(p.squash),
            (p.message as string | null | undefined) ?? null,
            Boolean((p.cleanup as boolean | undefined) ?? false),
          ),
        );
        return;
      case 'getBranchLog':
        respond(req.id, true, await getBranchLog(p.worktreePath as string));
        return;
      case 'pushTask':
        respond(req.id, true, await pushTask(p.projectRoot as string, p.branchName as string));
        return;
      case 'rebaseTask':
        respond(req.id, true, await rebaseTask(p.worktreePath as string));
        return;
      case 'createWorktree':
        respond(
          req.id,
          true,
          await createWorktree(
            p.repoRoot as string,
            p.branchName as string,
            (p.symlinkDirs as string[]) ?? [],
            Boolean(p.forceClean),
          ),
        );
        return;
      case 'removeWorktree':
        respond(
          req.id,
          true,
          await removeWorktree(
            p.repoRoot as string,
            p.branchName as string,
            Boolean(p.deleteBranch),
          ),
        );
        return;
      default:
        throw new Error(`Unknown git worker command: ${req.cmd}`);
    }
  } catch (err) {
    respond(req.id, false, undefined, String(err));
  }
}

parentPort?.on('message', (req: Req) => {
  void handle(req);
});
