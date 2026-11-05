import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLocalEndpoint, createArguments, effectiveDockerEndpoint } from './index.ts';

test('only local Unix socket runtimes are accepted', () => {
  assert.doesNotThrow(() => assertLocalEndpoint('unix:///var/run/docker.sock'));
  for (const endpoint of ['ssh://host', 'tcp://127.0.0.1:2375', 'https://remote', '']) {
    assert.throws(() => assertLocalEndpoint(endpoint), /Remote runtimes/);
  }
});

test('Docker context takes precedence over DOCKER_HOST before checking locality', async () => {
  const endpoint = await effectiveDockerEndpoint({ DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'unix:///var/run/docker.sock' }, async (name) => {
    assert.equal(name, 'remote');
    return 'ssh://remote-host';
  });
  assert.throws(() => assertLocalEndpoint(endpoint), /Remote runtimes/);
  assert.equal(await effectiveDockerEndpoint({ DOCKER_HOST: 'unix:///local.sock' }, async () => { throw new Error('Should not inspect context'); }), 'unix:///local.sock');
  assert.equal(await effectiveDockerEndpoint({}, async () => 'unix:///default.sock'), 'unix:///default.sock');
});

test('container uses caller-selected image, volumes and ports without editor assumptions', () => {
  const args = createArguments({ id: '123', name: 'project', root: '/projects/with spaces', containerName: 'vspod-123' }, {
    image: 'example:1', buildDirectory: 'example', volumes: ['data'], ports: [],
  });
  assert.equal(args.filter((arg) => arg.startsWith('type=bind,')).length, 1);
  assert.equal(args.filter((arg) => arg.startsWith('type=volume,')).length, 1);
  assert.ok(!args.includes('--publish'));
  assert.equal(args.at(-1), 'example:1');
  assert.ok(args.includes('1000:1000'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(!args.some((arg) => /PASSWORD|\.ssh|docker.sock|privileged/.test(arg)));
});