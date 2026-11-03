import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
}

export async function resolveWorkspace(directory: string) {
  const cwd = await realpath(resolve(directory));
  let output: string;
  try {
    ({ stdout: output } = await execute('git', ['-C', cwd, 'rev-parse', '--show-toplevel']));
  } catch {
    throw new Error('Open a Git repository: run git init in your project first.');
  }
  const root = await realpath(output.trimEnd());
  if (root === '/' || isInside(root, await realpath(homedir()))) {
    throw new Error('Refusing to mount your home directory or one of its parent directories.');
  }
  const { stdout } = await execute('git', ['-C', root, 'rev-parse', '--absolute-git-dir']);
  if (!isInside(root, await realpath(stdout.trimEnd()))) {
    throw new Error('Linked worktrees with Git metadata outside the repository are not supported. Use a separate clone.');
  }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 20);
  return { root, id, name: basename(root), containerName: `vspod-${id}` };
}

export type Workspace = Awaited<ReturnType<typeof resolveWorkspace>>;