import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isInside, resolveWorkspace } from './index.ts';

test('containment checks path components rather than prefixes', () => {
  assert.equal(isInside('/repo', '/repository'), false);
  assert.equal(isInside('/repo', '/repo/../secret'), false);
  assert.equal(isInside('/repo', '/repo/src'), true);
});

test('root, nested directory and symlink resolve to one repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vspod-test-'));
  try {
    const root = join(temporary, 'project with spaces');
    await mkdir(join(root, 'src'), { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);
    await symlink(root, join(temporary, 'alias'));
    const workspace = await resolveWorkspace(root);
    assert.deepEqual(await resolveWorkspace(join(root, 'src')), workspace);
    assert.deepEqual(await resolveWorkspace(join(temporary, 'alias')), workspace);
    assert.match(workspace.containerName, /^vspod-[a-f0-9]{20}$/);
    await assert.rejects(resolveWorkspace(temporary), /Git repository/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});