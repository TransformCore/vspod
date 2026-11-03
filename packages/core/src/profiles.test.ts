import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProfile, listProfiles, readProfile, selectedProfile, switchProfile } from './profiles.ts';

test('virtual default, profile creation, copy, private permissions and no-clobber writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-profiles-'));
  try {
    assert.deepEqual(await listProfiles(root), ['default']);
    assert.equal((await selectedProfile(undefined, root)).name, 'default');
    await createProfile('default', undefined, root);
    const original = join(root, 'profiles/default/profile.yml');
    await writeFile(original, 'schemaVersion: 1\ntheme: one-dark\nextensions:\n  - github.copilot\n', { mode: 0o600 });
    await createProfile('work', 'default', root);
    assert.equal((await readProfile('work', root)).theme, 'one-dark');
    assert.equal((await readProfile('work', root)).name, 'work');
    assert.equal((await stat(join(root, 'profiles/work/profile.yml'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'profiles/work'))).mode & 0o777, 0o700);
    const before = await readFile(original, 'utf8');
    await assert.rejects(createProfile('default', undefined, root), { code: 'PROFILE_EXISTS' });
    assert.equal(await readFile(original, 'utf8'), before);
    await assert.rejects(createProfile('../escape', undefined, root), { code: 'PROFILE_NAME_INVALID' });
    await assert.rejects(readProfile('absent', root), { code: 'PROFILE_NOT_FOUND' });
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('global and repository selections are validated, atomic and independent under concurrent writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-profiles-'));
  const one = 'a'.repeat(20);
  const two = 'b'.repeat(20);
  try {
    await createProfile('work', undefined, root);
    await createProfile('personal', undefined, root);
    await switchProfile('work', undefined, root);
    assert.equal((await selectedProfile(one, root)).name, 'work');
    await Promise.all([
      switchProfile('personal', one, root),
      switchProfile('default', two, root),
    ]);
    assert.equal((await selectedProfile(one, root)).name, 'personal');
    assert.equal((await selectedProfile(two, root)).name, 'default');
    assert.equal((await selectedProfile(undefined, root)).name, 'work');
    const before = await readFile(join(root, 'profile-selections.json'), 'utf8');
    await assert.rejects(switchProfile('missing', one, root), { code: 'PROFILE_NOT_FOUND' });
    assert.equal(await readFile(join(root, 'profile-selections.json'), 'utf8'), before);
    await writeFile(join(root, 'profile-selections.json'), '{"schemaVersion":2}', { mode: 0o600 });
    await assert.rejects(selectedProfile(one, root), { code: 'PROFILE_STATE_INVALID' });
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('profile reads reject public files and symlinked directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-profiles-'));
  try {
    await createProfile('work', undefined, root);
    await chmod(join(root, 'profiles/work/profile.yml'), 0o644);
    await assert.rejects(readProfile('work', root), { code: 'PROFILE_PATH_UNSAFE' });
    await mkdir(join(root, 'other'));
    await symlink(join(root, 'other'), join(root, 'profiles/linked'));
    await assert.rejects(readProfile('linked', root), { code: 'PROFILE_PATH_UNSAFE' });
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('an incomplete default profile and malformed selection metadata never fall back silently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-profile-invalid-'));
  try {
    await createProfile('default', undefined, root);
    await rm(join(root, 'profiles/default/profile.yml'));
    await assert.rejects(readProfile('default', root), { code: 'PROFILE_NOT_FOUND' });
    await writeFile(join(root, 'profile-selections.json'), '{"defaultProfile":"DO_NOT_ECHO', { mode: 0o600 });
    await assert.rejects(selectedProfile(undefined, root), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'PROFILE_STATE_INVALID');
      assert.doesNotMatch(String(error), /DO_NOT_ECHO/);
      return true;
    });
  } finally { await rm(root, { force: true, recursive: true }); }
});
