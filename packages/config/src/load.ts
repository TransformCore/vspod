import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { parseDocument, LineCounter, visit } from 'yaml';
import { getNodeValue, parseTree } from 'jsonc-parser';
import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { ConfigurationError, validateCompatibilityExtensions, validateDocument, validateSettings } from './validate.ts';
import type { CompatibilityInput, ProfileV1, RepositoryDefinitionV1 } from './model.ts';

export const MAX_CONFIGURATION_BYTES = 256 * 1024;
export const COMPATIBILITY_PATHS = ['.vscode/settings.json', '.vscode/extensions.json'] as const;

export interface CompatibilitySnapshot {
  input: CompatibilityInput;
  sources: readonly {
    path: typeof COMPATIBILITY_PATHS[number];
    digest: string | null;
  }[];
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix));
}

export async function readConfiguration(path: string, root: string): Promise<string | undefined> {
  return (await readConfigurationSnapshot(path, root))?.text;
}

async function readConfigurationSnapshot(path: string, root: string): Promise<{ text: string; digest: string } | undefined> {
  let canonical: string;
  try { canonical = await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const entry = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT') return undefined;
        throw new ConfigurationError('CONFIG_READ', path);
      });
      if (entry) throw new ConfigurationError('CONFIG_PATH_UNSAFE', path);
      return undefined;
    }
    throw new ConfigurationError('CONFIG_READ', path);
  }
  if (!inside(await realpath(root), canonical)) throw new ConfigurationError('CONFIG_PATH_UNSAFE', path);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new ConfigurationError('CONFIG_READ', path);
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('CONFIG_LIMIT', path);
    const buffer = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('CONFIG_LIMIT', path);
    const bytes = buffer.subarray(0, length);
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('CONFIG_READ', path);
  } finally { await file.close(); }
}

export function parseYaml(text: string, source: string): unknown {
  if (Buffer.byteLength(text) > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('CONFIG_LIMIT', source);
  const lineCounter = new LineCounter();
  try {
    const document = parseDocument(text, {
      version: '1.2', uniqueKeys: true, stringKeys: true, lineCounter,
      schema: 'core', logLevel: 'silent', prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length) {
      const issue = document.errors[0] ?? document.warnings[0];
      const position = lineCounter.linePos(issue.pos[0]);
      throw new ConfigurationError('CONFIG_PARSE', source, '', position.line, position.col);
    }
    visit(document, {
      Node(_key, _node, ancestors) {
        if (ancestors.length > 32) throw new ConfigurationError('CONFIG_LIMIT', source);
      },
    });
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('CONFIG_PARSE', source);
  }
}

export function parseJsonc(text: string, source: string): unknown {
  if (Buffer.byteLength(text) > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('CONFIG_LIMIT', source);
  try { return parseJsoncDocument(text, source); } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('CONFIG_PARSE', source);
  }
}

function parseJsoncDocument(text: string, source: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !tree) {
    const prefix = text.slice(0, errors[0]?.offset ?? 0).split('\n');
    throw new ConfigurationError('CONFIG_PARSE', source, '', prefix.length, prefix.at(-1)!.length + 1);
  }
  function check(node: JsonNode, depth: number): void {
    if (depth > 32) throw new ConfigurationError('CONFIG_LIMIT', source);
    if (node.type === 'object') {
      const keys = node.children?.map((property) => property.children![0].value);
      if (keys && new Set(keys).size !== keys.length) throw new ConfigurationError('CONFIG_PARSE', source);
    }
    for (const child of node.children ?? []) check(child, depth + 1);
  }
  check(tree, 0);
  return getNodeValue(tree);
}

export async function loadProfile(path: string, root: string): Promise<ProfileV1 | undefined> {
  const text = await readConfiguration(path, root);
  return text === undefined ? undefined : validateDocument(parseYaml(text, path), 'profile', path);
}

export async function loadRepository(root: string): Promise<RepositoryDefinitionV1 | undefined> {
  const path = join(root, '.vspod', 'vspod.yml');
  const text = await readConfiguration(path, root);
  return text === undefined ? undefined : validateDocument(parseYaml(text, path), 'repository', path);
}

export async function loadCompatibility(root: string, enabled: boolean): Promise<CompatibilityInput | undefined> {
  if (!enabled) return undefined;
  return (await loadCompatibilitySnapshot(root)).input;
}

export async function loadCompatibilitySnapshot(root: string): Promise<CompatibilitySnapshot> {
  const [settingsPath, extensionsPath] = COMPATIBILITY_PATHS.map((path) => join(root, path));
  const [settings, extensions] = await Promise.all([
    readConfigurationSnapshot(settingsPath, root), readConfigurationSnapshot(extensionsPath, root),
  ]);
  return {
    input: {
      settings: settings === undefined ? {} : validateSettings(parseJsonc(settings.text, settingsPath), settingsPath),
      ...(extensions === undefined ? { recommendations: [], unwantedRecommendations: [] }
        : validateCompatibilityExtensions(parseJsonc(extensions.text, extensionsPath), extensionsPath)),
    },
    sources: COMPATIBILITY_PATHS.map((path, index) => {
      return { path, digest: [settings, extensions][index]?.digest ?? null };
    }),
  };
}
