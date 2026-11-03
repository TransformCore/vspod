import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError, planMigration } from '@vspod/config';
import type { MigrationOptions, MigrationPlan } from '@vspod/config';
import type { Workspace } from '@vspod/workspace';
import { VspodError } from './errors.ts';
import { operationSignal } from './process.ts';
import { withProjectLock } from './state.ts';

export interface MigrationResult extends MigrationPlan {
  status: 'preview' | 'written';
  destination: string;
  activation: 'not-activated';
}

async function entry(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new VspodError('MIGRATION_READ', 'Migration destination could not be inspected.',
      'Check repository ownership and permissions. No existing destination was overwritten.');
  }
}

async function checkDestination(workspace: Workspace) {
  const directory = join(workspace.root, '.vspod');
  const info = await entry(directory);
  if (info && (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())) {
    throw new VspodError('MIGRATION_PATH_UNSAFE', 'The .vspod destination is not a real directory owned by you.',
      'Use a real .vspod directory inside this repository, not a file or symlink. Existing content was not changed.');
  }
  if (info && await entry(join(directory, 'vspod.yml'))) {
    throw new VspodError('MIGRATION_DESTINATION_EXISTS', '.vspod/vspod.yml already exists.',
      'Review the existing definition manually. Migration never overwrites or merges an existing destination.');
  }
  return info;
}

function changed(): VspodError {
  return new VspodError('MIGRATION_INPUT_CHANGED', 'Migration inputs changed after the preview.',
    'Run vspod migrate again, review the new preview, then retry. No definition was published.');
}

async function verifyPlan(workspace: Workspace, expected: MigrationPlan): Promise<MigrationPlan> {
  const current = await planMigration(workspace.root, { recommendationsAsRequired: expected.recommendationsAsRequired });
  if (current.yaml !== expected.yaml || JSON.stringify(current.sources) !== JSON.stringify(expected.sources)) throw changed();
  return current;
}

export async function writeMigration(workspace: Workspace, preview: MigrationPlan): Promise<MigrationResult> {
  return withProjectLock(workspace, async () => {
    operationSignal()?.throwIfAborted();
    await checkDestination(workspace);
    const current = await verifyPlan(workspace, preview);
    const directory = join(workspace.root, '.vspod');
    let createdDirectory = false;
    let temporary: string | undefined;
    let published = false;
    let stagingDirectory: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      try {
        await mkdir(directory, { mode: 0o700 });
        createdDirectory = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const owner = await checkDestination(workspace);
      if (!owner) throw new VspodError('MIGRATION_PATH_UNSAFE', 'The migration directory disappeared.', 'Restore a real .vspod directory and retry.');
      stagingDirectory = owner;
      temporary = join(directory, `.migration-${randomBytes(12).toString('hex')}.pending`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(current.yaml, 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await verifyPlan(workspace, current);
      const beforePublish = await checkDestination(workspace);
      if (!beforePublish || beforePublish.dev !== owner.dev || beforePublish.ino !== owner.ino) {
        throw new VspodError('MIGRATION_PATH_UNSAFE', 'The migration directory changed during the write.', 'Review repository changes and retry. No definition was published.');
      }
      operationSignal()?.throwIfAborted();
      // link() publishes the complete staged inode atomically and never replaces an existing path.
      await link(temporary, join(directory, 'vspod.yml'));
      published = true;
    } catch (error) {
      if (error instanceof VspodError || error instanceof ConfigurationError) throw error;
      operationSignal()?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VspodError('MIGRATION_DESTINATION_EXISTS', '.vspod/vspod.yml was created by another operation.',
          'Review the existing definition. It was not overwritten.');
      }
      throw new VspodError('MIGRATION_WRITE', 'Migration could not publish the repository definition.',
        'Check free space and repository permissions, then retry. Source files and existing definitions were not changed.');
    } finally {
      try {
        const cleanupDirectory = await entry(directory);
        if (stagingDirectory && (!cleanupDirectory || cleanupDirectory.isSymbolicLink() ||
            cleanupDirectory.dev !== stagingDirectory.dev || cleanupDirectory.ino !== stagingDirectory.ino)) {
          throw new Error('Staging directory no longer matches.');
        }
        if (temporary) await rm(temporary, { force: true });
        if (createdDirectory && !published) {
          await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
          });
        }
      } catch {
        throw new VspodError('MIGRATION_CLEANUP', published
          ? 'The definition was published, but migration staging cleanup failed.'
          : 'Migration failed and its staging cleanup could not finish.',
        'Inspect .vspod for a .migration-*.pending file before retrying. Do not remove vspod.yml without reviewing it.');
      }
    }
    return {
      ...current, status: 'written', destination: join(directory, 'vspod.yml'), activation: 'not-activated',
    };
  });
}

export async function migrateWorkspace(
  workspace: Workspace,
  options: MigrationOptions & { write?: boolean } = {},
): Promise<MigrationResult> {
  await checkDestination(workspace);
  const preview = await planMigration(workspace.root, options);
  if (options.write) return writeMigration(workspace, preview);
  return {
    ...preview, status: 'preview', destination: join(workspace.root, '.vspod/vspod.yml'), activation: 'not-activated',
  };
}
