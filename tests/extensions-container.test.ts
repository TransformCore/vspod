import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerRuntime } from '@vspod/docker';
import { CodeServerBackend, CODE_SERVER_ENVIRONMENT, DesktopBackend } from '@vspod/editor-backends';
import { resolveWorkspace } from '@vspod/workspace';
import type { CachedExtensionArtifact } from '@vspod/extensions';
import { inspectConfiguration, syncWorkspaceExtensions, trustConfiguration } from '@vspod/core';
import { assertWorkspaceExtensions } from '../packages/core/src/extensions.ts';

for (const kind of ['code-server', 'desktop'] as const) {
test(`${kind} isolated installer installs exact local VSIX files without starting the workspace`, {
  skip: kind === 'desktop' ? process.env.VSPOD_DESKTOP_TEST !== '1' : process.env.VSPOD_DOCKER_TEST !== '1', timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-test-extension-install-'));
  const repo = join(root, 'vspod-test-project');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const workspace = await resolveWorkspace(repo);
  const desktop = new DesktopBackend();
  const runtime = kind === 'desktop' ? desktop.runtime : new DockerRuntime(CODE_SERVER_ENVIRONMENT);
  const backend = kind === 'desktop' ? desktop : new CodeServerBackend(runtime);
  let created = false;
  try {
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    await runtime.create(workspace);
    created = true;
    const extension = join(root, 'extension');
    await mkdir(extension);
    await writeFile(join(extension, 'package.json'), JSON.stringify({
      name: 'install-probe', publisher: 'vspod', version: '1.2.3',
      engines: { vscode: '^1.106.0' }, displayName: 'VSPod install probe', description: 'Local test only',
    }));
    await writeFile(join(root, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="install-probe" Version="1.2.3" Publisher="vspod"/>
<DisplayName>VSPod install probe</DisplayName><Description xml:space="preserve">Local test</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.106.0" /></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
<Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`);
    await writeFile(join(root, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>');
    const cachePath = join(root, 'probe.vsix');
    execFileSync('/usr/bin/zip', ['-q', '-r', cachePath, 'extension', 'extension.vsixmanifest', '[Content_Types].xml'], { cwd: root });
    const artifact: CachedExtensionArtifact = {
      id: 'vspod.install-probe', version: '1.2.3', engineRange: '^1.106.0',
      downloadUrl: 'https://open-vsx.org/api/vspod/install-probe/1.2.3/file/vspod.install-probe-1.2.3.vsix',
      cachePath, sha256: createHash('sha256').update(await readFile(cachePath)).digest('hex'),
    };
    const adapter = backend.extensionAdapter(workspace);
    assert.deepEqual(await adapter.list(), []);
    await adapter.install(artifact);
    assert.deepEqual(await adapter.list(), [{ id: artifact.id, version: artifact.version }]);
    assert.equal((await runtime.inspect(workspace))!.running, false);
    await adapter.uninstall(artifact.id);
    assert.deepEqual(await adapter.list(), []);
  } finally {
    if (created) { await runtime.remove(workspace); await runtime.removeTestVolumes(workspace); }
    await rm(root, { recursive: true, force: true });
  }
});
}

test('approved Open VSX ESLint resolves, validates, installs and reuses an immutable managed pin', {
  skip: process.env.VSPOD_EXTENSION_REGISTRY_TEST !== '1', timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-test-extension-registry-'));
  const previous = process.env.VSPOD_STATE_DIR;
  const previousConfig = process.env.VSPOD_CONFIG_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  process.env.VSPOD_CONFIG_DIR = join(root, 'configuration');
  const repo = join(root, 'vspod-test-project');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const workspace = await resolveWorkspace(repo);
  const runtime = new DockerRuntime(CODE_SERVER_ENVIRONMENT);
  const backend = new CodeServerBackend(runtime);
  try {
    await mkdir(join(repo, '.vspod'));
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\nextensions:\n  required: [dbaeumer.vscode-eslint@3.0.34]\n');
    await trustConfiguration(workspace, (await inspectConfiguration(workspace)).resolved);
    let approvals = 0;
    const outcomes = await syncWorkspaceExtensions(backend, workspace, {
      approveArtifacts: async (artifacts) => {
        approvals += artifacts.length;
        for (const artifact of artifacts) {
          assert.equal(artifact.id, 'dbaeumer.vscode-eslint');
          assert.equal(artifact.version, '3.0.34');
          assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
        }
        return artifacts.map(({ id, version, sha256 }) => ({ id, version, sha256 }));
      },
    }).catch((error: unknown) => {
      if (error instanceof Error && 'hint' in error) throw new Error(`${error.message}: ${error.hint}`, { cause: error });
      throw error;
    });
    assert.equal(approvals, 1);
    assert.ok(outcomes.some((item) => item.id === 'dbaeumer.vscode-eslint' && item.status === 'installed'));
    assert.ok((await backend.extensionAdapter(workspace).list()).some((item) => item.id === 'dbaeumer.vscode-eslint' && item.version === '3.0.34'));
    const again = await syncWorkspaceExtensions(backend, workspace, {
      approveArtifacts: async () => { throw new Error('Unchanged managed pins never need new approval'); },
    });
    assert.ok(again.some((item) => item.id === 'dbaeumer.vscode-eslint' && item.status === 'unchanged'));
    assert.equal((await runtime.inspect(workspace))!.running, false);
    const configuration = (await inspectConfiguration(workspace)).resolved;
    const state = join(root, 'state', workspace.id);
    await assertWorkspaceExtensions(backend, workspace, state, configuration);
    await backend.extensionAdapter(workspace).uninstall('dbaeumer.vscode-eslint');
    await assert.rejects(assertWorkspaceExtensions(backend, workspace, state, configuration), { code: 'EXTENSION_REQUIRED_UNAVAILABLE' });
  } finally {
    if (await runtime.inspect(workspace)) {
      await runtime.remove(workspace);
      await runtime.removeTestVolumes(workspace);
    }
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = previous;
    if (previousConfig === undefined) delete process.env.VSPOD_CONFIG_DIR; else process.env.VSPOD_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
