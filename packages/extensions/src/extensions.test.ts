import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { after, test } from 'node:test';
import type { ExtensionIntent } from '@vspod/config';
import {
  ExtensionManager, ExtensionRegistryError, OpenVsxRegistry, RequiredExtensionFailure,
  type ExtensionArtifactApprovalRequest,
  type CachedExtensionArtifact, type ExtensionRuntimeAdapter,
} from './index.ts';

const root = resolve('packages/extensions/.test-state');

async function createCache(): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'test-'));
}

after(async () => rm(root, { recursive: true, force: true }));

function intent(id: string, values: Partial<ExtensionIntent> = {}): ExtensionIntent {
  return { id, required: false, selected: true, sources: ['profile'], ...values };
}

function approveAll(artifacts: readonly ExtensionArtifactApprovalRequest[]) {
  return Promise.resolve(artifacts.map(({ id, version, sha256 }) => ({ id, version, sha256 })));
}

function openVsx(fetcher: typeof fetch, maxArtifactBytes?: number): OpenVsxRegistry {
  return new OpenVsxRegistry({ fetch: fetcher, ...(maxArtifactBytes ? { maxArtifactBytes } : {}) });
}

function response(data: unknown, headers?: HeadersInit): Response {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status: 200, headers });
}

function responseBytes(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer);
}

function metadata(id: string, version: string, download = `https://open-vsx.org/api/${id.replace('.', '/')}/${version}/file/${id}.vsix`) {
  const [namespace, name] = id.split('.');
  return { namespace, name, version, engines: { vscode: '^1.80.0' }, files: { download } };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createVsix(options: {
  id?: string;
  version?: string;
  engineRange?: string;
  targetPlatform?: string;
  packageTargetPlatform?: string;
  manifestTargetPlatform?: string;
  packageBytes?: Uint8Array;
  manifestId?: string;
  manifestVersion?: string;
} = {}): Uint8Array {
  const [publisher = 'publisher', name = 'tool'] = (options.id ?? 'publisher.tool').split('.');
  const version = options.version ?? '1.2.3';
  const engineRange = options.engineRange ?? '^1.80.0';
  const packageTargetPlatform = options.packageTargetPlatform ?? options.targetPlatform;
  const manifestTargetPlatform = options.manifestTargetPlatform ?? options.targetPlatform;
  const manifestTarget = manifestTargetPlatform
    ? `<TargetPlatform>${manifestTargetPlatform}</TargetPlatform>` : '';
  const pkg = options.packageBytes ?? new TextEncoder().encode(JSON.stringify({
    publisher, name, version, engines: { vscode: engineRange },
    ...(packageTargetPlatform ? { __metadata: { targetPlatform: packageTargetPlatform } } : {}),
  }));
  const files: [string, Uint8Array][] = [
    ['extension/package.json', pkg],
    ['extension.vsixmanifest', new TextEncoder().encode(
      `<PackageManifest><Metadata><Identity Id="${options.manifestId ?? name}" Version="${options.manifestVersion ?? version}" Publisher="${publisher}"/>${manifestTarget}</Metadata></PackageManifest>`,
    )],
  ];
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;
  for (const [nameInZip, contents] of files) {
    const nameBytes = new TextEncoder().encode(nameInZip);
    const compressed = new Uint8Array(deflateRawSync(contents));
    const crc = crc32(contents);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 8, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, contents.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    const localRecord = new Uint8Array(localHeader.length + compressed.length);
    localRecord.set(localHeader);
    localRecord.set(compressed, localHeader.length);
    localRecords.push(localRecord);
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 8, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, contents.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralRecords.push(centralHeader);
    offset += localRecord.length;
  }
  const centralBytes = new Uint8Array(centralRecords.reduce((total, entry) => total + entry.length, 0));
  let centralOffset = 0;
  for (const entry of centralRecords) {
    centralBytes.set(entry, centralOffset);
    centralOffset += entry.length;
  }
  const localBytes = localRecords.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, localBytes, true);
  const archive = new Uint8Array(localBytes + centralBytes.length + end.length);
  let position = 0;
  for (const entry of localRecords) {
    archive.set(entry, position);
    position += entry.length;
  }
  archive.set(centralBytes, position);
  archive.set(end, position + centralBytes.length);
  return archive;
}

class MockAdapter implements ExtensionRuntimeAdapter {
  readonly installed: CachedExtensionArtifact[] = [];
  readonly uninstalled: string[] = [];
  current: { id: string; version: string }[] = [];
  async install(artifact: CachedExtensionArtifact): Promise<void> {
    this.installed.push(artifact);
    this.current = this.current.filter((item) => item.id.toLowerCase() !== artifact.id.toLowerCase());
    this.current.push({ id: artifact.id, version: artifact.version });
  }
  async list(): Promise<readonly { id: string; version: string }[]> { return [...this.current]; }
  async uninstall(id: string): Promise<void> {
    this.uninstalled.push(id);
    this.current = this.current.filter((item) => item.id.toLowerCase() !== id.toLowerCase());
  }
}

test('resolves and validates Open VSX identity, version, engine, and fixed download origin', async () => {
  const registry = openVsx(async (input) => {
    assert.match(String(input), /^https:\/\/open-vsx\.org\/api\/publisher\/tool\/latest$/);
    return response(metadata('publisher.tool', '1.2.3'));
  });
  assert.deepEqual(await registry.resolve('publisher.tool', undefined, '1.90.0'), {
    id: 'publisher.tool', version: '1.2.3', engineRange: '^1.80.0',
    downloadUrl: 'https://open-vsx.org/api/publisher/tool/1.2.3/file/publisher.tool.vsix',
  });

  const wrongIdentity = openVsx(async () => response(metadata('other.tool', '1.2.3')));
  await assert.rejects(() => wrongIdentity.resolve('publisher.tool', undefined, '1.90.0'), /different extension identity/);
  const wrongEngine = openVsx(async () => response({ ...metadata('publisher.tool', '1.2.3'), engines: { vscode: '^2.0.0' } }));
  await assert.rejects(() => wrongEngine.resolve('publisher.tool', undefined, '1.90.0'), /requires VS Code/);
  const hostileDownload = openVsx(async () => response(metadata('publisher.tool', '1.2.3', 'https://attacker.example/file.vsix')));
  await assert.rejects(() => hostileDownload.resolve('publisher.tool', undefined, '1.90.0'), /untrusted download URL/);
});

test('allows only one fixed Open VSX artifact redirect to the matching Eclipse content path', async () => {
  const artifactMetadata = {
    id: 'publisher.tool', version: '1.2.3', engineRange: '^1.80.0',
    downloadUrl: 'https://open-vsx.org/api/publisher/tool/1.2.3/file/tool.vsix',
  };
  const requests: string[] = [];
  const registry = openVsx(async (input, options) => {
    const url = String(input);
    requests.push(url);
    assert.equal(options?.credentials, 'omit');
    if (url.startsWith('https://open-vsx.org/')) {
      assert.equal(options?.redirect, 'manual');
      return new Response(null, {
        status: 302, headers: { location: 'https://openvsx.eclipsecontent.org/publisher/tool/1.2.3/tool.vsix' },
      });
    }
    assert.equal(options?.redirect, 'error');
    return responseBytes(createVsix());
  });
  assert.ok((await registry.download(artifactMetadata)).byteLength > 0);
  assert.equal(requests.length, 2);

  for (const location of [
    'https://attacker.example/publisher/tool/1.2.3/tool.vsix',
    'https://openvsx.eclipsecontent.org/other/tool/1.2.3/tool.vsix',
    'https://openvsx.eclipsecontent.org/publisher/tool/1.2.3/tool.vsix?credential=bad',
    'http://openvsx.eclipsecontent.org/publisher/tool/1.2.3/tool.vsix',
  ]) {
    let requestCount = 0;
    const rejected = openVsx(async () => {
      requestCount++;
      return new Response(null, { status: 302, headers: { location } });
    });
    await assert.rejects(() => rejected.download(artifactMetadata), /not an approved fixed content destination/);
    assert.equal(requestCount, 1);
  }
});

test('bounds artifact downloads before storing a content-addressed immutable cache entry', async () => {
  const bytes = createVsix();
  const registry = openVsx(async (input) => {
    const url = String(input);
    if (url.endsWith('/latest')) return response(metadata('publisher.tool', '1.2.3'));
    if (url.includes('/file/')) return responseBytes(bytes);
    return response(metadata('publisher.tool', url.split('/').at(-1) ?? '1.2.3'));
  }, 4);
  await assert.rejects(() => registry.download({
    id: 'publisher.tool', version: '1.2.3', engineRange: '^1.80.0',
    downloadUrl: 'https://open-vsx.org/api/publisher/tool/1.2.3/file/tool.vsix',
  }), /exceeds the 4-byte limit/);

  const directory = await createCache();
  try {
    const adapter = new MockAdapter();
    const manager = new ExtensionManager({ cacheDirectory: directory, vscodeVersion: '1.90.0', adapter,
      approveArtifacts: approveAll,
      registry: openVsx(async (input) => {
        const url = String(input);
        if (url.endsWith('/latest')) return response(metadata('publisher.tool', '1.2.3'));
        if (url.includes('/file/')) return responseBytes(bytes);
        return response(metadata('publisher.tool', url.split('/').at(-1) ?? '1.2.3'));
      }) });
    await manager.reconcile([intent('publisher.tool')]);
    const pin = (await manager.managedPins())[0];
    assert.equal(pin.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(adapter.installed[0].cachePath, join(directory, 'artifacts', `${pin.sha256}.vsix`));
    assert.deepEqual((await readdir(join(directory, 'artifacts'))), [`${pin.sha256}.vsix`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('warm apply stays pinned and explicit refresh is the only route to a newer version', async () => {
  const directory = await createCache();
  const bytes = createVsix({ version: '1.2.3' });
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/latest')) return response(metadata('publisher.tool', '1.2.3'));
    if (url.includes('/file/')) {
      const version = url.includes('/1.3.0/') ? '1.3.0' : '1.2.3';
      return responseBytes(createVsix({ version }));
    }
    return response(metadata('publisher.tool', url.split('/').at(-1) ?? '1.2.3'));
  };
  const adapter = new MockAdapter();
  const manager = new ExtensionManager({
    cacheDirectory: directory, vscodeVersion: '1.90.0', adapter, approveArtifacts: approveAll, registry: openVsx(fetcher),
  });
  try {
    await manager.apply([intent('publisher.tool')]);
    await manager.apply([intent('publisher.tool')]);
    assert.equal(adapter.installed.length, 1);
    assert.ok(requests.some((url) => url.endsWith('/publisher/tool/1.2.3')));
    assert.equal(requests.filter((url) => url.endsWith('/latest')).length, 1);

    const refreshing = new ExtensionManager({ cacheDirectory: directory, vscodeVersion: '1.90.0', adapter,
      approveArtifacts: approveAll,
      registry: openVsx(async (input) => {
        const url = String(input);
        if (url.endsWith('/latest')) return response(metadata('publisher.tool', '1.3.0'));
        if (url.includes('/file/')) return responseBytes(createVsix({ version: '1.3.0' }));
        return response(metadata('publisher.tool', url.split('/').at(-1) ?? '1.3.0'));
      }) });
    await refreshing.apply([intent('publisher.tool')], { refresh: true });
    assert.equal(adapter.installed.length, 2);
    assert.equal((await refreshing.managedPins())[0].version, '1.3.0');
    const manifest = JSON.parse(await readFile(join(directory, 'managed-extensions.json'), 'utf8'));
    assert.equal(manifest.extensions[0].version, '1.3.0');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires approval for the exact downloaded version and digest, with workspace state separated from shared cache', async () => {
  const directory = await createCache();
  const manifestPath = join(directory, 'workspace-a', 'managed.json');
  const bytes = createVsix({ id: 'publisher.reviewed', version: '4.5.6' });
  const adapter = new MockAdapter();
  let asked: readonly ExtensionArtifactApprovalRequest[] = [];
  const manager = new ExtensionManager({
    cacheDirectory: directory,
    manifestPath,
    vscodeVersion: '1.90.0',
    adapter,
    approveArtifacts: async (artifacts) => {
      asked = artifacts;
      return artifacts.map(({ id, version, sha256 }) => ({
        id, version, sha256: `${sha256.slice(0, -1)}${sha256.endsWith('0') ? '1' : '0'}`,
      }));
    },
    registry: openVsx(async (input) => {
      const url = String(input);
      if (url.endsWith('/latest')) return response(metadata('publisher.reviewed', '4.5.6'));
      if (url.includes('/file/')) return responseBytes(bytes);
      return response(metadata('publisher.reviewed', url.split('/').at(-1) ?? '4.5.6'));
    }),
  });
  try {
    const outcome = await manager.reconcile([intent('publisher.reviewed')]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(asked, [{ id: 'publisher.reviewed', version: '4.5.6', sha256: digest, required: false }]);
    assert.equal(outcome[0].status, 'approval-required');
    assert.equal(adapter.installed.length, 0);
    assert.deepEqual(await manager.managedPins(), []);
    assert.deepEqual(new Uint8Array(await readFile(join(directory, 'artifacts', `${digest}.vsix`))), bytes);
    assert.equal((await readdir(join(directory, 'workspace-a'))).includes('managed.json'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects tampered VSIX identity, version, engine, platform, and oversized package manifests before approval', async () => {
  const directory = await createCache();
  const cases: { name: string; artifact: Uint8Array }[] = [
    { name: 'publisher', artifact: createVsix({ id: 'attacker.tool' }) },
    { name: 'version', artifact: createVsix({ version: '9.9.9' }) },
    { name: 'engine', artifact: createVsix({ engineRange: '^2.0.0' }) },
    { name: 'platform', artifact: createVsix({ manifestTargetPlatform: 'linux-x64' }) },
    { name: 'package platform', artifact: createVsix({ packageTargetPlatform: 'linux-x64' }) },
    {
      name: 'manifest size',
      artifact: createVsix({ packageBytes: new Uint8Array(1024 * 1024 + 1).fill(0x20) }),
    },
  ];
  try {
    for (const { name, artifact } of cases) {
      let approvalCalled = false;
      const adapter = new MockAdapter();
      const manager = new ExtensionManager({
        cacheDirectory: join(directory, name),
        vscodeVersion: '1.90.0',
        adapter,
        approveArtifacts: async (items) => {
          approvalCalled = true;
          return items.map(({ id, version, sha256 }) => ({ id, version, sha256 }));
        },
        registry: openVsx(async (input) => String(input).endsWith('/latest')
          ? response(metadata('publisher.tool', '1.2.3'))
          : String(input).includes('/file/')
            ? responseBytes(artifact)
            : response(metadata('publisher.tool', '1.2.3'))),
      });
      const [outcome] = await manager.reconcile([intent('publisher.tool')]);
      assert.equal(outcome.status, 'failed', `${name} artifact should fail validation`);
      assert.equal(approvalCalled, false, `${name} artifact should not reach approval`);
      assert.equal(adapter.installed.length, 0, `${name} artifact should not be installed`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves unmanaged extensions and only uninstalls previously managed entries', async () => {
  const directory = await createCache();
  const adapter = new MockAdapter();
  adapter.current = [{ id: 'publisher.manual', version: '1.0.0' }];
  const manager = new ExtensionManager({ cacheDirectory: directory, vscodeVersion: '1.90.0', adapter, approveArtifacts: approveAll, registry: openVsx(async (input) => {
    const url = String(input);
    if (url.endsWith('/latest')) return response(metadata('publisher.managed', '2.0.0'));
    if (url.includes('/file/')) return responseBytes(createVsix({ id: 'publisher.managed', version: '2.0.0' }));
    return response(metadata('publisher.managed', url.split('/').at(-1) ?? '2.0.0'));
  }) });
  try {
    const outcomes = await manager.apply([intent('publisher.manual')]);
    assert.equal(outcomes[0].status, 'preserved');
    assert.deepEqual(await manager.managedPins(), []);
    await manager.apply([intent('publisher.managed')]);
    await manager.apply([]);
    assert.deepEqual(adapter.uninstalled, ['publisher.managed']);
    assert.deepEqual(adapter.current, [{ id: 'publisher.manual', version: '1.0.0' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports optional failures without throwing and exposes required failures distinctly', async () => {
  const directory = await createCache();
  const registry = openVsx(async () => new Response('unavailable', { status: 503 }));
  try {
    const optional = new ExtensionManager({ cacheDirectory: directory, vscodeVersion: '1.90.0', adapter: new MockAdapter(), approveArtifacts: approveAll, registry });
    const outcomes = await optional.apply([intent('publisher.optional')]);
    assert.equal(outcomes[0].status, 'failed');
    assert.equal(outcomes[0].required, false);
    const skipped = await optional.apply([intent('publisher.recommendation', { selected: false })]);
    assert.equal(skipped[0].status, 'skipped');

    const required = new ExtensionManager({ cacheDirectory: directory, vscodeVersion: '1.90.0', adapter: new MockAdapter(), approveArtifacts: approveAll, registry });
    await assert.rejects(
      () => required.apply([intent('publisher.required', { required: true })]),
      (error: unknown) => error instanceof RequiredExtensionFailure
        && error.outcomes.some((outcome) => outcome.id === 'publisher.required' && outcome.required && outcome.status === 'failed'),
    );

    const unavailableAdapter: ExtensionRuntimeAdapter = {
      install: async () => { throw new Error('must not install'); },
      list: async () => { throw new Error('runtime unavailable'); },
      uninstall: async () => { throw new Error('must not uninstall'); },
    };
    const adapterFailure = new ExtensionManager({
      cacheDirectory: directory, vscodeVersion: '1.90.0', adapter: unavailableAdapter, approveArtifacts: approveAll, registry,
    });
    const optionalFailure = await adapterFailure.apply([intent('publisher.adapter-failure')]);
    assert.equal(optionalFailure[0].status, 'failed');
    assert.equal(optionalFailure[0].required, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid extension IDs before registry requests', async () => {
  const registry = openVsx(async () => { throw new Error('must not fetch'); });
  await assert.rejects(() => registry.resolve('publisher/../tool', undefined, '1.90.0'), ExtensionRegistryError);
});
