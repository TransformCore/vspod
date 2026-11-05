import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeServerBackend, CODE_SERVER_ENVIRONMENT } from './code-server.ts';
import { createArguments } from '@vspod/docker';
import type { EditorPresentation, EditorSession } from '@vspod/core/backend';

const instance = { id: 'container', startedAt: 'now', running: true, ports: { '8080': 'http://127.0.0.1:49152' } };
const session: EditorSession = {
  backend: 'code-server', containerId: 'container', startedAt: 'now',
  presentation: { kind: 'web', origin: 'http://127.0.0.1:12345', authentication: { kind: 'password', password: 'a'.repeat(64) } },
};

test('code-server resumes matching web sessions with the inspected origin', () => {
  const backend = new CodeServerBackend();
  const resumed = backend.resume(instance, session);
  assert.equal(resumed.presentation.kind, 'web');
  if (resumed.presentation.kind !== 'web') throw new Error('Expected web session');
  assert.equal(resumed.presentation.origin, instance.ports['8080']);
  assert.equal(resumed.presentation.authentication.password, 'a'.repeat(64));
  assert.equal(session.presentation.kind === 'web' && session.presentation.origin, 'http://127.0.0.1:12345');
});

test('code-server rejects stale, foreign, malformed and native sessions without fallback', () => {
  const backend = new CodeServerBackend();
  const invalid = [
    undefined, { ...session, backend: 'desktop' }, { ...session, containerId: 'other' },
    { ...session, startedAt: 'old' },
    { ...session, presentation: { kind: 'native' as const, sessionId: 'native' } },
    { ...session, presentation: { kind: 'web' as const, origin: 'http://127.0.0.1:49152',
      authentication: { kind: 'password' as const, password: 'invalid' } } },
  ];
  for (const value of invalid) assert.throws(() => backend.resume(instance, value), { code: 'SESSION_UNAVAILABLE' });
  assert.throws(() => backend.resume({ ...instance, running: false }, session), { code: 'SESSION_UNAVAILABLE' });
  assert.throws(() => backend.resume({ ...instance, ports: {} }, session), /loopback code-server port/);
  assert.throws(() => backend.resume({ ...instance, ports: { '8080': 'http://remote:8080' } }, session), /loopback editor/);
});

test('native presentations require neither URL nor a web password', () => {
  const presentation: EditorPresentation = { kind: 'native', sessionId: 'runner-session' };
  assert.deepEqual(Object.keys(presentation).sort(), ['kind', 'sessionId']);
});

test('code-server owns its image, port and four-volume editor layout', () => {
  const args = createArguments({ id: '123', name: 'project', root: '/projects/with spaces', containerName: 'vspod-123' }, CODE_SERVER_ENVIRONMENT);
  assert.equal(args.filter((arg) => arg.startsWith('type=bind,')).length, 1);
  assert.equal(args.filter((arg) => arg.startsWith('type=volume,')).length, 4);
  assert.ok(args.includes('127.0.0.1::8080'));
  assert.equal(args.at(-1), CODE_SERVER_ENVIRONMENT.image);
  assert.ok(!args.some((arg) => /PASSWORD|\.ssh|docker.sock|privileged/.test(arg)));
});
