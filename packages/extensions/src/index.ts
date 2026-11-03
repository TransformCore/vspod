import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { satisfies, valid } from 'semver';
import type { ExtensionIntent } from '@vspod/config';

export const OPEN_VSX_API = 'https://open-vsx.org/api';
export const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_VSIX_ENTRIES = 10_000;
const MANIFEST_VERSION = 1;

export interface ExtensionMetadata {
  id: string;
  version: string;
  engineRange: string;
  downloadUrl: string;
}

export interface CachedExtensionArtifact extends ExtensionMetadata {
  sha256: string;
  cachePath: string;
}

export interface InstalledExtension {
  id: string;
  version: string;
}

export interface ExtensionRuntimeAdapter {
  install(artifact: CachedExtensionArtifact): Promise<void>;
  list(): Promise<readonly InstalledExtension[]>;
  uninstall(id: string): Promise<void>;
}

export interface OpenVsxRegistryOptions {
  fetch?: typeof globalThis.fetch;
  maxArtifactBytes?: number;
}

export class ExtensionRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtensionRegistryError';
  }
}

export class OpenVsxRegistry {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly maxArtifactBytes: number;

  constructor(options: OpenVsxRegistryOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes < 1) {
      throw new Error('maxArtifactBytes must be a positive safe integer.');
    }
  }

  async resolve(id: string, requestedVersion: string | undefined, vscodeVersion: string): Promise<ExtensionMetadata> {
    const [namespace, name] = splitId(id);
    if (!valid(vscodeVersion)) throw new ExtensionRegistryError(`Invalid VS Code version: ${vscodeVersion}`);
    const versionPath = requestedVersion === undefined ? 'latest' : encodeURIComponent(requestedVersion);
    const url = `${OPEN_VSX_API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${versionPath}`;
    const response = await this.request(url, MAX_METADATA_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(response));
    } catch (error) {
      throw new ExtensionRegistryError(`Open VSX returned invalid metadata for ${id}.`, { cause: error });
    }

    if (!isRecord(value) || typeof value.namespace !== 'string' || typeof value.name !== 'string'
      || typeof value.version !== 'string' || !isRecord(value.files)
      || typeof value.files.download !== 'string' || !isRecord(value.engines)
      || typeof value.engines.vscode !== 'string') {
      throw new ExtensionRegistryError(`Open VSX metadata is incomplete for ${id}.`);
    }
    if (`${value.namespace}.${value.name}`.toLowerCase() !== id.toLowerCase()) {
      throw new ExtensionRegistryError(`Open VSX returned a different extension identity for ${id}.`);
    }
    if (!valid(value.version) || (requestedVersion !== undefined && value.version !== requestedVersion)) {
      throw new ExtensionRegistryError(`Open VSX returned an unexpected version for ${id}.`);
    }
    if (!satisfies(vscodeVersion, value.engines.vscode)) {
      throw new ExtensionRegistryError(
        `${id}@${value.version} requires VS Code ${value.engines.vscode}; host is ${vscodeVersion}.`,
      );
    }

    let downloadUrl: URL;
    try {
      downloadUrl = new URL(value.files.download);
    } catch (error) {
      throw new ExtensionRegistryError(`Open VSX returned an invalid download URL for ${id}.`, { cause: error });
    }
    if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'open-vsx.org'
      || downloadUrl.username || downloadUrl.password) {
      throw new ExtensionRegistryError(`Open VSX returned an untrusted download URL for ${id}.`);
    }
    return { id: `${value.namespace}.${value.name}`, version: value.version, engineRange: value.engines.vscode, downloadUrl: downloadUrl.href };
  }

  async download(metadata: ExtensionMetadata): Promise<Uint8Array> {
    const url = new URL(metadata.downloadUrl);
    if (url.origin !== 'https://open-vsx.org' || url.username || url.password) {
      throw new ExtensionRegistryError('Artifacts must originate at the fixed Open VSX endpoint.');
    }
    const bytes = await this.request(metadata.downloadUrl, this.maxArtifactBytes, true);
    if (!bytes.byteLength) throw new ExtensionRegistryError(`Open VSX returned an empty artifact for ${metadata.id}.`);
    return bytes;
  }

  private async request(url: string, maxBytes: number, allowArtifactRedirect = false): Promise<Uint8Array> {
    let response: Response;
    try {
      const signal = AbortSignal.timeout(120_000);
      response = await this.fetcher(url, { redirect: 'manual', signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (allowArtifactRedirect && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        const destination = location ? new URL(location, url) : undefined;
        const source = new URL(url);
        const fixedArtifactPath = source.pathname.match(/^\/api\/([^/]+\/[^/]+\/[^/]+)\/file\/([^/]+\.vsix)$/);
        if (!destination || destination.origin !== 'https://openvsx.eclipsecontent.org'
          || destination.username || destination.password || destination.search || destination.hash
          || !fixedArtifactPath || destination.pathname !== `/${fixedArtifactPath[1]}/${fixedArtifactPath[2]}`) {
          await response.body?.cancel();
          throw new ExtensionRegistryError('Open VSX artifact redirect is not an approved fixed content destination.');
        }
        await response.body?.cancel();
        response = await this.fetcher(destination.href, {
          redirect: 'error', signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        });
      }
    } catch (error) {
      if (error instanceof ExtensionRegistryError) throw error;
      throw new ExtensionRegistryError('Unable to fetch extension data from Open VSX.', { cause: error });
    }
    if (!response.ok) throw new ExtensionRegistryError(`Open VSX request failed with HTTP ${response.status}.`);
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      await response.body?.cancel();
      throw new ExtensionRegistryError(`Open VSX response exceeds the ${maxBytes}-byte limit.`);
    }
    if (!response.body) throw new ExtensionRegistryError('Open VSX returned a response without a body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new ExtensionRegistryError(`Open VSX response exceeds the ${maxBytes}-byte limit.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

export interface ManagedExtensionPin {
  id: string;
  version: string;
  /** Content-integrity digest only; it does not authenticate the publisher. */
  sha256: string;
}

interface ManagedManifest {
  schemaVersion: 1;
  extensions: ManagedExtensionPin[];
}

export type ExtensionOutcomeStatus = 'installed' | 'unchanged' | 'preserved' | 'skipped' | 'approval-required' | 'failed' | 'removed';

export interface ExtensionOutcome {
  id: string;
  status: ExtensionOutcomeStatus;
  version?: string;
  message?: string;
  required: boolean;
}

export interface ExtensionReconcileOptions {
  refresh?: boolean;
  approveArtifacts?: (artifacts: readonly ExtensionArtifactApprovalRequest[]) => Promise<readonly ExtensionArtifactApproval[]>;
}

export type ExtensionApplyOptions = ExtensionReconcileOptions;

export interface ExtensionArtifactApprovalRequest {
  id: string;
  version: string;
  sha256: string;
  required: boolean;
}

export interface ExtensionArtifactApproval {
  id: string;
  version: string;
  sha256: string;
}

export class RequiredExtensionFailure extends Error {
  readonly outcomes: readonly ExtensionOutcome[];
  readonly failed: readonly ExtensionOutcome[];

  constructor(outcomes: readonly ExtensionOutcome[]) {
    const failures = outcomes.filter((outcome) => outcome.required && ['failed', 'approval-required'].includes(outcome.status));
    super(`Failed to apply required extensions: ${failures.map((item) => item.id).join(', ')}.`);
    this.name = 'RequiredExtensionFailure';
    this.outcomes = outcomes;
    this.failed = failures;
  }
}

export interface ExtensionManagerOptions {
  /** Shared immutable artifact cache directory. */
  cacheDirectory: string;
  /** State manifest path; set to a canonical-workspace-specific path to isolate managed pins per workspace. */
  manifestPath?: string;
  vscodeVersion: string;
  adapter: ExtensionRuntimeAdapter;
  registry?: OpenVsxRegistry;
  approveArtifacts?: ExtensionReconcileOptions['approveArtifacts'];
}

export class ExtensionManager {
  private readonly cacheDirectory: string;
  private readonly manifestPath: string;
  private readonly vscodeVersion: string;
  private readonly adapter: ExtensionRuntimeAdapter;
  private readonly registry: OpenVsxRegistry;
  private readonly approveArtifacts?: ExtensionManagerOptions['approveArtifacts'];
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: ExtensionManagerOptions) {
    if (!valid(options.vscodeVersion)) throw new Error(`Invalid VS Code version: ${options.vscodeVersion}`);
    this.cacheDirectory = options.cacheDirectory;
    this.manifestPath = options.manifestPath ?? join(options.cacheDirectory, 'managed-extensions.json');
    this.vscodeVersion = options.vscodeVersion;
    this.adapter = options.adapter;
    this.registry = options.registry ?? new OpenVsxRegistry();
    this.approveArtifacts = options.approveArtifacts;
  }

  apply(intents: readonly ExtensionIntent[], options: ExtensionApplyOptions = {}): Promise<readonly ExtensionOutcome[]> {
    return this.reconcile(intents, options);
  }

  reconcile(intents: readonly ExtensionIntent[], options: ExtensionReconcileOptions = {}): Promise<readonly ExtensionOutcome[]> {
    const operation = this.pending.then(() => this.applySerially(intents, options));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async managedPins(): Promise<readonly ManagedExtensionPin[]> {
    return (await this.readManifest()).extensions;
  }

  private async applySerially(
    intents: readonly ExtensionIntent[],
    options: ExtensionApplyOptions,
  ): Promise<readonly ExtensionOutcome[]> {
    const desired = new Map<string, ExtensionIntent>();
    const skipped = new Map<string, ExtensionIntent>();
    for (const intent of intents) {
      validateIntent(intent);
      if (intent.required || intent.selected) desired.set(intent.id.toLowerCase(), intent);
      else skipped.set(intent.id.toLowerCase(), intent);
    }
    const manifest = await this.readManifest();
    const pins = new Map(manifest.extensions.map((pin) => [pin.id.toLowerCase(), pin]));
    const outcomes: ExtensionOutcome[] = [];
    const pendingInstalls: { key: string; intent: ExtensionIntent; artifact: CachedExtensionArtifact }[] = [];
    for (const [key, intent] of skipped) {
      if (!desired.has(key) && !pins.has(key)) {
        outcomes.push({ id: intent.id, status: 'skipped', required: false, message: 'Optional extension was not selected.' });
      }
    }

    let installed: Map<string, InstalledExtension>;
    try {
      installed = new Map((await this.adapter.list()).map((item) => [item.id.toLowerCase(), item]));
    } catch (error) {
      const message = errorMessage(error);
      for (const intent of desired.values()) {
        outcomes.push({ id: intent.id, status: 'failed', required: intent.required, message });
      }
      for (const [key, pin] of pins) {
        if (!desired.has(key)) outcomes.push({ id: pin.id, status: 'failed', version: pin.version, required: false, message });
      }
      if (outcomes.some((outcome) => outcome.required && ['failed', 'approval-required'].includes(outcome.status))) {
        throw new RequiredExtensionFailure(outcomes);
      }
      return outcomes;
    }

    for (const [key, intent] of desired) {
      const previous = pins.get(key);
      const current = installed.get(key);
      if (current && !previous) {
        if (intent.version && current.version !== intent.version) {
          outcomes.push({ id: intent.id, status: 'failed', version: current.version, required: intent.required,
            message: `A manually installed version (${current.version}) conflicts with the requested pin (${intent.version}); it was left unchanged.` });
        } else {
          outcomes.push({ id: intent.id, status: 'preserved', version: current.version, required: intent.required });
        }
        continue;
      }

      try {
        const canReusePin = previous && !options.refresh && (!intent.version || intent.version === previous.version);
        const metadata = canReusePin
          ? await this.registry.resolve(intent.id, previous.version, this.vscodeVersion)
          : await this.registry.resolve(intent.id, intent.version, this.vscodeVersion);
        const artifact = await this.getArtifact(metadata, canReusePin ? previous.sha256 : undefined);
        if (current?.version === metadata.version && previous?.version === metadata.version && previous.sha256 === artifact.sha256) {
          outcomes.push({ id: intent.id, status: 'unchanged', version: metadata.version, required: intent.required });
          continue;
        }
        pendingInstalls.push({ key, intent, artifact });
      } catch (error) {
        outcomes.push({ id: intent.id, status: 'failed', required: intent.required, message: errorMessage(error) });
      }
    }

    if (pendingInstalls.length) {
      let approved = new Set<string>();
      try {
        const approvalRequests = pendingInstalls.map(({ intent, artifact }) => ({
          id: artifact.id, version: artifact.version, sha256: artifact.sha256, required: intent.required,
        }));
        const approvalCallback = options.approveArtifacts ?? this.approveArtifacts;
        const decisions = await approvalCallback?.(approvalRequests) ?? [];
        approved = new Set(decisions.map(approvalKey));
      } catch (error) {
        for (const { intent } of pendingInstalls) {
          outcomes.push({ id: intent.id, status: 'failed', required: intent.required, message: `Artifact approval failed: ${errorMessage(error)}` });
        }
      }

      for (const { key, intent, artifact } of pendingInstalls) {
        const exactKey = approvalKey(artifact);
        if (!approved.has(exactKey)) {
          if (!outcomes.some((outcome) => outcome.id === intent.id && outcome.status === 'failed')) {
            outcomes.push({
              id: intent.id, status: 'approval-required', version: artifact.version, required: intent.required,
              message: 'No approval was provided for this exact extension version and artifact digest.',
            });
          }
          continue;
        }
        try {
          await this.adapter.install(artifact);
          installed.set(key, { id: artifact.id, version: artifact.version });
          pins.set(key, { id: artifact.id, version: artifact.version, sha256: artifact.sha256 });
          outcomes.push({ id: intent.id, status: 'installed', version: artifact.version, required: intent.required });
        } catch (error) {
          outcomes.push({ id: intent.id, status: 'failed', required: intent.required, message: errorMessage(error) });
        }
      }
    }

    for (const [key, pin] of pins) {
      if (desired.has(key)) continue;
      try {
        if (installed.has(key)) await this.adapter.uninstall(pin.id);
        installed.delete(key);
        pins.delete(key);
        outcomes.push({ id: pin.id, status: 'removed', version: pin.version, required: false });
      } catch (error) {
        outcomes.push({ id: pin.id, status: 'failed', version: pin.version, required: false, message: errorMessage(error) });
      }
    }

    await this.writeManifest([...pins.values()].sort((a, b) => a.id.localeCompare(b.id)));
    if (outcomes.some((outcome) => outcome.required && ['failed', 'approval-required'].includes(outcome.status))) {
      throw new RequiredExtensionFailure(outcomes);
    }
    return outcomes;
  }

  private async getArtifact(metadata: ExtensionMetadata, expectedHash?: string): Promise<CachedExtensionArtifact> {
    const directory = join(this.cacheDirectory, 'artifacts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (expectedHash) {
      const expectedPath = join(directory, `${expectedHash}.vsix`);
      try {
        if (await fileMatchesHash(expectedPath, expectedHash)) {
          await validateVsix(new Uint8Array(await readFile(expectedPath)), metadata);
          return { ...metadata, sha256: expectedHash, cachePath: expectedPath };
        }
        await rm(expectedPath, { force: true });
      } catch {
        // A missing artifact is restored from the fixed Open VSX endpoint below.
      }
    }

    const bytes = await this.registry.download(metadata);
    await validateVsix(bytes, metadata);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedHash && sha256 !== expectedHash) {
      throw new ExtensionRegistryError(`Cached content hash changed for ${metadata.id}@${metadata.version}.`);
    }
    const finalPath = join(directory, `${sha256}.vsix`);
    try {
      const file = await open(finalPath, 'wx', 0o444);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(finalPath, 0o444);
    } catch (error) {
      if (!isCode(error, 'EEXIST') || !(await fileMatchesHash(finalPath, sha256))) throw error;
    }
    return { ...metadata, sha256, cachePath: finalPath };
  }

  private async readManifest(): Promise<ManagedManifest> {
    const path = this.manifestPath;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isCode(error, 'ENOENT')) return { schemaVersion: 1, extensions: [] };
      throw error;
    }
    if (text.length > MAX_METADATA_BYTES) {
      throw new Error('The managed-extension manifest exceeds its size limit; no extensions were changed.');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error('The managed-extension manifest is invalid JSON; no extensions were changed.', { cause: error });
    }
    if (!isRecord(value) || value.schemaVersion !== MANIFEST_VERSION
      || !Array.isArray(value.extensions) || !value.extensions.every(isManagedPin)
      || new Set(value.extensions.map((pin) => pin.id.toLowerCase())).size !== value.extensions.length) {
      throw new Error('The managed-extension manifest is invalid; no extensions were changed.');
    }
    return { schemaVersion: 1, extensions: value.extensions };
  }

  private async writeManifest(extensions: ManagedExtensionPin[]): Promise<void> {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    const temporaryPath = join(dirname(this.manifestPath), `.managed-extensions-${randomUUID()}.json`);
    const contents = `${JSON.stringify({ schemaVersion: 1, extensions }, null, 2)}\n`;
    try {
      await openWriteFile(temporaryPath, contents);
      await rename(temporaryPath, this.manifestPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function validateVsix(bytes: Uint8Array, metadata: ExtensionMetadata): Promise<void> {
  const entries = readZipDirectory(bytes);
  const packageJson = entries.get('extension/package.json');
  if (!packageJson) throw new ExtensionRegistryError(`VSIX is missing extension/package.json for ${metadata.id}.`);
  const manifestJson = await readZipEntry(bytes, packageJson, MAX_METADATA_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestJson));
  } catch (error) {
    throw new ExtensionRegistryError(`VSIX package.json is invalid for ${metadata.id}.`, { cause: error });
  }
  if (!isRecord(value) || typeof value.publisher !== 'string' || typeof value.name !== 'string'
    || typeof value.version !== 'string' || !isRecord(value.engines) || typeof value.engines.vscode !== 'string') {
    throw new ExtensionRegistryError(`VSIX package.json is incomplete for ${metadata.id}.`);
  }
  const actualId = `${value.publisher}.${value.name}`;
  if (actualId.toLowerCase() !== metadata.id.toLowerCase() || value.version !== metadata.version) {
    throw new ExtensionRegistryError(`VSIX package identity does not match resolved metadata for ${metadata.id}@${metadata.version}.`);
  }
  if (value.engines.vscode !== metadata.engineRange) {
    throw new ExtensionRegistryError(`VSIX VS Code engine range does not match resolved metadata for ${metadata.id}@${metadata.version}.`);
  }
  const packageTarget = isRecord(value.__metadata) && typeof value.__metadata.targetPlatform === 'string'
    ? value.__metadata.targetPlatform : undefined;
  if (packageTarget && packageTarget !== 'universal') {
    throw new ExtensionRegistryError(`Platform-specific VSIX artifacts are not supported (${packageTarget}).`);
  }
  const vsixManifest = entries.get('extension.vsixmanifest');
  if (vsixManifest) {
    const xmlBytes = await readZipEntry(bytes, vsixManifest, MAX_METADATA_BYTES);
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes);
    const targetPlatform = xml.match(/<TargetPlatform>\s*([^<]+?)\s*<\/TargetPlatform>/i)?.[1];
    if (targetPlatform && targetPlatform !== 'universal') {
      throw new ExtensionRegistryError(`Platform-specific VSIX artifacts are not supported (${targetPlatform}).`);
    }
    const identity = xml.match(/<Identity\b([^>]*)>/i)?.[1];
    if (identity) {
      const id = identity.match(/\bId="([^"]+)"/i)?.[1];
      const version = identity.match(/\bVersion="([^"]+)"/i)?.[1];
      const publisher = identity.match(/\bPublisher="([^"]+)"/i)?.[1];
      const identityMatches = id?.toLowerCase() === value.name.toLowerCase()
        || id?.toLowerCase() === actualId.toLowerCase();
      if (!identityMatches || publisher?.toLowerCase() !== value.publisher.toLowerCase() || version !== metadata.version) {
        throw new ExtensionRegistryError(`VSIX manifest identity does not match package.json for ${metadata.id}.`);
      }
    }
  }
}

interface ZipEntry {
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  name: string;
}

function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.byteLength) throw new ExtensionRegistryError('Downloaded VSIX is not a valid ZIP archive.');
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber || centralDisk || diskEntries !== entryCount || entryCount === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || entryCount > MAX_VSIX_ENTRIES || centralOffset + centralSize > eocd) {
    throw new ExtensionRegistryError('VSIX ZIP directory is multi-disk, ZIP64, oversized, or invalid.');
  }

  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > centralOffset + centralSize || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ExtensionRegistryError('VSIX ZIP directory entry is invalid.');
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > centralOffset + centralSize || diskStart !== 0 || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ExtensionRegistryError('VSIX ZIP directory entry is unsupported or truncated.');
    }
    if (flags & 1 || (compression !== 0 && compression !== 8)) {
      throw new ExtensionRegistryError('VSIX uses encrypted or unsupported ZIP compression.');
    }
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const segments = name.split('/');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || segments.some((segment) => segment === '..' || segment === '.')
      || ((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      throw new ExtensionRegistryError('VSIX contains an unsafe ZIP entry path.');
    }
    if (entries.has(name)) throw new ExtensionRegistryError(`VSIX contains a duplicate ZIP entry: ${name}.`);
    entries.set(name, { flags, compression, crc32, compressedSize, uncompressedSize, localOffset, name });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new ExtensionRegistryError('VSIX ZIP directory size is inconsistent.');
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maximumBytes: number): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.uncompressedSize > maximumBytes || entry.compressedSize > maximumBytes
    || entry.localOffset + 30 > bytes.byteLength || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
    throw new ExtensionRegistryError(`VSIX ${entry.name} is oversized or invalid.`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const localFlags = view.getUint16(entry.localOffset + 6, true);
  const localCompression = view.getUint16(entry.localOffset + 8, true);
  if (localFlags !== entry.flags || localCompression !== entry.compression) {
    throw new ExtensionRegistryError(`VSIX ${entry.name} local ZIP metadata is inconsistent.`);
  }
  if (!(entry.flags & 8) && (view.getUint32(entry.localOffset + 14, true) !== entry.crc32
    || view.getUint32(entry.localOffset + 18, true) !== entry.compressedSize
    || view.getUint32(entry.localOffset + 22, true) !== entry.uncompressedSize)) {
    throw new ExtensionRegistryError(`VSIX ${entry.name} local ZIP sizes are inconsistent.`);
  }
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new ExtensionRegistryError(`VSIX ${entry.name} is truncated.`);
  const localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength));
  if (localName !== entry.name) throw new ExtensionRegistryError(`VSIX ${entry.name} local ZIP header is inconsistent.`);
  let result: Uint8Array;
  try {
    result = entry.compression === 0
      ? bytes.slice(start, end)
      : new Uint8Array(inflateRawSync(bytes.subarray(start, end), { maxOutputLength: maximumBytes }));
  } catch (error) {
    throw new ExtensionRegistryError(`VSIX ${entry.name} cannot be safely decompressed.`, { cause: error });
  }
  if (result.byteLength !== entry.uncompressedSize || crc32(result) !== entry.crc32) {
    throw new ExtensionRegistryError(`VSIX ${entry.name} ZIP integrity check failed.`);
  }
  return result;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function splitId(id: string): [string, string] {
  const parts = id.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(part))) {
    throw new ExtensionRegistryError(`Invalid extension ID: ${id}. Expected publisher.name.`);
  }
  return [parts[0], parts[1]];
}

function validateIntent(intent: ExtensionIntent): void {
  if (!intent || typeof intent !== 'object' || typeof intent.id !== 'string') {
    throw new Error('Invalid extension intent.');
  }
  splitId(intent.id);
  if (intent.version !== undefined && !valid(intent.version)) throw new Error(`Invalid extension version for ${intent.id}.`);
  if (typeof intent.required !== 'boolean' || typeof intent.selected !== 'boolean') {
    throw new Error(`Invalid extension intent flags for ${intent.id}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isManagedPin(value: unknown): value is ManagedExtensionPin {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.version !== 'string'
    || valid(value.version) === null || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  try {
    splitId(value.id);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function fileMatchesHash(path: string, expected: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    return digest === expected;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function openWriteFile(path: string, contents: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(contents, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

export type { ExtensionIntent };

function approvalKey(value: { id: string; version: string; sha256: string }): string {
  return `${value.id.toLowerCase()}@${value.version}#${value.sha256}`;
}
