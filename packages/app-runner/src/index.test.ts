import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { containerArguments, writeHostConfiguration, type AppLaunchSpec } from './index.ts';

const spec: AppLaunchSpec = {
  id: 'notes-123',
  image: 'example/notes:1',
  command: ['/usr/bin/notes', 'a document.txt'],
  workdir: '/data',
  mounts: [{ kind: 'volume', source: 'notes-data', target: '/data' }],
  seccompProfile: '/host/renderer-seccomp.json',
  resources: { cpus: 2, memoryMiB: 2048, pids: 512, shmMiB: 512, tmpMiB: 1024 },
  scale: 2,
  exportRoots: ['/data'],
  integrations: { clipboard: true, files: true, externalUrls: false },
};

test('launch contract is independent of Git, VS Code and VSPod configuration', () => {
  const args = containerArguments(spec);
  assert.deepEqual(args.slice(-3), [spec.image, ...spec.command]);
  for (const flag of ['--read-only', '--init', '--cap-drop', '--security-opt']) assert.ok(args.includes(flag));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('seccomp=/host/renderer-seccomp.json'));
  assert.ok(args.includes('APP_RUNNER_EXPORT_ROOTS=["/data"]'));
  assert.ok(args.includes('APP_RUNNER_ELECTRON_MENU_NUDGE=0'));
  assert.ok(args.includes('type=volume,source=notes-data,target=/data'));
  assert.ok(!args.includes('--publish'));
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.some((arg) => arg.includes('code-server') || arg.includes('/workspace')));
});

test('commands remain argument arrays, without a shell or entrypoint override', () => {
  const command = ['/bin/printf', 'spaces; $(not-a-shell)'];
  assert.deepEqual(containerArguments({ ...spec, command }).slice(-3), [spec.image, ...command]);
  assert.ok(!containerArguments(spec).includes('--entrypoint'));
});

test('rejects invalid names, paths, limits, environment and mount targets', () => {
  const invalid: AppLaunchSpec[] = [
    { ...spec, id: '--privileged' },
    { ...spec, image: '--privileged' },
    { ...spec, command: [] },
    { ...spec, command: ['relative-command'] },
    { ...spec, workdir: '/data/../etc' },
    { ...spec, seccompProfile: 'unconfined' },
    { ...spec, resources: { ...spec.resources, cpus: 0 } },
    { ...spec, resources: { ...spec.resources, memoryMiB: NaN } },
    { ...spec, mounts: [{ kind: 'bind', source: '/host,readonly', target: '/data' }] },
    { ...spec, mounts: [{ kind: 'bind', source: '/host', target: '/tmp/runtime' }] },
    { ...spec, exportRoots: ['/'] },
    { ...spec, environment: { LD_PRELOAD: '/data/evil.so' } },
    { ...spec, environment: { APP_RUNNER_EXPORT_ROOTS: '["/"]' } },
  ];
  for (const value of invalid) assert.throws(() => containerArguments(value));
});

test('integration and Electron compatibility flags are explicit opt-ins', () => {
  const args = containerArguments({ ...spec, electronMenuNudge: true, environment: { NOTES_THEME: 'dark' } });
  assert.ok(args.includes('APP_RUNNER_ELECTRON_MENU_NUDGE=1'));
  assert.ok(args.includes('NOTES_THEME=dark'));
});

test('host configuration is private, versioned and defaults to detach on host quit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  try {
    const path = await writeHostConfiguration(root, {
      container: 'notes-123', protocol: 'wayland', integrations: spec.integrations,
    });
    const value = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(value.version, 1);
    assert.deepEqual(value.bridge, ['/opt/app-runner/vspod-compositor', '--bridge']);
    assert.equal(value.stopGuestOnQuit, false);
    assert.equal(value.protocol, 'wayland');
    assert.equal(value.root, await realpath(root));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(writeHostConfiguration(root, {
      container: 'notes-123', protocol: 'wayland', integrations: spec.integrations,
    }), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
