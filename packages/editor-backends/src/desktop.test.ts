import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerArguments } from '@vspod/app-runner';
import { CodeServerBackend } from './code-server.ts';
import { DesktopBackend, DESKTOP_ENVIRONMENT, desktopLaunchSpec, desktopSeccompPolicy } from './desktop.ts';
import type { EditorSession } from '@vspod/core/backend';

const workspace = { id: 'a'.repeat(20), name: 'project', root: '/projects/example', containerName: `vspod-${'a'.repeat(20)}` };

test('desktop defaults to the byte-identical tested bundled policy with restrictive syscall defaults', async () => {
  const path = await desktopSeccompPolicy({});
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '107f451f9ac595bd29249e35dcef8177f4cff9e4951b74675e792a284b49c6de');
  const policy = JSON.parse(bytes.toString());
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  assert.ok(Array.isArray(policy.syscalls) && policy.syscalls.length > 0);
  assert.ok(containerArguments(desktopLaunchSpec(workspace, path)).includes(`seccomp=${path}`));
});

test('explicit policy overrides are used and invalid paths fail without fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-seccomp-'));
  try {
    const path = join(root, 'custom.json');
    await writeFile(path, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
    assert.equal(await desktopSeccompPolicy({ VSPOD_DESKTOP_SECCOMP: path }), path);
    for (const candidate of ['', 'unconfined', 'relative.json', root, join(root, 'missing.json')]) {
      await assert.rejects(desktopSeccompPolicy({ VSPOD_DESKTOP_SECCOMP: candidate }), { code: 'DESKTOP_SECCOMP_INVALID' });
    }
    await assert.rejects(desktopSeccompPolicy({}, root), { code: 'DESKTOP_SECCOMP_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop spec isolates storage, uses a real workspace and retains renderer hardening', () => {
  const spec = desktopLaunchSpec(workspace, '/host/renderer.json');
  const args = containerArguments(spec);
  assert.equal(spec.id, `${workspace.containerName}-desktop`);
  assert.equal(DESKTOP_ENVIRONMENT.ports.length, 0);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('seccomp=/host/renderer.json'));
  assert.ok(!args.includes('--publish'));
  assert.ok(!args.some((arg) => arg.includes('unconfined') || arg.includes('--no-sandbox')));
  assert.equal(spec.mounts.filter((mount) => mount.kind === 'bind').length, 1);
  assert.deepEqual(spec.mounts[0], { kind: 'bind', source: workspace.root, target: '/workspace' });
  assert.ok(spec.mounts.filter((mount) => mount.kind === 'volume').every((mount) => mount.source.includes('-desktop-')));
  assert.deepEqual(spec.exportRoots, ['/workspace']);
});

test('native sessions have no web credential and reject stale, foreign and web sessions', () => {
  const backend = new DesktopBackend();
  const instance = { id: 'container', startedAt: 'generation', running: true };
  const session: EditorSession = {
    backend: 'desktop', containerId: instance.id, startedAt: instance.startedAt,
    presentation: { kind: 'native', sessionId: `${workspace.containerName}-desktop` },
  };
  assert.equal(backend.resume(instance, session), session);
  assert.ok(!JSON.stringify(session).includes('password'));
  const candidates: (EditorSession | undefined)[] = [
    undefined, { ...session, backend: 'code-server' }, { ...session, startedAt: 'old' },
    { ...session, containerId: 'other' },
    { ...session, presentation: { kind: 'web', origin: 'http://127.0.0.1:8080', authentication: { kind: 'password', password: 'a'.repeat(64) } } },
    { ...session, presentation: { kind: 'native', sessionId: '../other' } },
  ];
  for (const candidate of candidates) {
    assert.throws(() => backend.resume(instance, candidate), { code: 'SESSION_UNAVAILABLE' });
  }
  assert.throws(() => backend.resume({ ...instance, running: false }, session), { code: 'SESSION_UNAVAILABLE' });
  assert.throws(() => new CodeServerBackend().resume(instance, session), { code: 'SESSION_UNAVAILABLE' });
});
