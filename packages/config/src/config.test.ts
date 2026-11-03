import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigurationError, loadCompatibility, loadRepository, MAX_CONFIGURATION_BYTES,
  mergeSettings, parseJsonc, parseYaml, resolveConfiguration, validateDocument,
} from './index.ts';

function rejects(code: string) {
  return (error: unknown) => error instanceof ConfigurationError && error.code === code;
}

test('settings precedence, array replacement, null and input immutability', () => {
  const profile = { schemaVersion: 1 as const, theme: 'one-dark', settings: { 'editor.tabSize': 8, 'editor.rulers': [80, 120] } };
  const original = structuredClone(profile);
  const result = resolveConfiguration({
    profile,
    compatibility: { settings: { 'editor.tabSize': 3 }, recommendations: [], unwantedRecommendations: [] },
    repository: { schemaVersion: 1, settings: { 'editor.tabSize': 2, 'editor.rulers': [100], 'workbench.iconTheme': null } },
  });
  assert.equal(result.settings['editor.tabSize'], 2);
  assert.equal(result.settings['workbench.colorTheme'], 'one-dark');
  assert.deepEqual(result.settings['editor.rulers'], [100]);
  assert.equal(result.settings['workbench.iconTheme'], null);
  assert.equal(result.provenance['editor.tabSize'], 'repository');
  assert.equal(result.provenance['files.autoSave'], 'defaults');
  assert.deepEqual(profile, original);
  assert.deepEqual(mergeSettings({ a: { x: 1 } }, { a: { y: 2 } }), { a: { y: 2 } });
});

test('resolution fingerprint is deterministic, sensitive to values, and default-only is supported', () => {
  const left = resolveConfiguration({ repository: { schemaVersion: 1, settings: { 'editor.tabSize': 2, 'editor.formatOnSave': true } } });
  const right = resolveConfiguration({ repository: { schemaVersion: 1, settings: { 'editor.formatOnSave': true, 'editor.tabSize': 2 } } });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.notEqual(left.fingerprint, resolveConfiguration().fingerprint);
  assert.match(left.fingerprint, /^[a-f0-9]{64}$/);
});

test('compatibility exclusions match extension identity across pinned versions without removing profile intent', () => {
  const result = resolveConfiguration({
    profile: { schemaVersion: 1, extensions: ['github.copilot'] },
    compatibility: {
      settings: {},
      recommendations: ['github.copilot@1.2.3', 'eamodio.gitlens@2.0.0'],
      unwantedRecommendations: ['github.copilot', 'eamodio.gitlens@1.0.0'],
    },
  });
  assert.deepEqual(result.extensions, [{
    id: 'github.copilot', required: false, selected: true, sources: ['profile'],
  }]);
});

test('extension intent merge preserves required, profile selection and optional recommendations', () => {
  const result = resolveConfiguration({
    profile: { schemaVersion: 1, extensions: ['github.copilot', 'eamodio.gitlens@1.2.3'] },
    compatibility: { settings: {}, recommendations: ['github.copilot', 'ignored.extension'], unwantedRecommendations: ['ignored.extension'] },
    repository: {
      schemaVersion: 1,
      extensions: { required: ['github.copilot'], optional: ['ms-playwright.playwright'] },
      accounts: { required: ['azure', 'github'], optional: ['github', 'salesforce'] },
    },
  });
  assert.deepEqual(result.extensions.find((entry) => entry.id === 'github.copilot'), {
    id: 'github.copilot', required: true, selected: true, sources: ['compatibility', 'profile', 'repository'],
  });
  assert.equal(result.extensions.find((entry) => entry.id === 'ms-playwright.playwright')?.selected, false);
  assert.equal(result.extensions.some((entry) => entry.id === 'ignored.extension'), false);
  assert.deepEqual(result.accounts, { required: ['azure', 'github'], optional: ['salesforce'] });
  assert.throws(() => resolveConfiguration({
    profile: { schemaVersion: 1, extensions: ['eamodio.gitlens@1.2.3'] },
    repository: { schemaVersion: 1, extensions: { required: ['eamodio.gitlens@2.0.0'] } },
  }), rejects('EXTENSION_VERSION_CONFLICT'));
});

test('schema versions, unsupported settings, secrets, non-JSON values and unsafe keys fail explicitly', () => {
  for (const [value, code] of [
    [{}, 'CONFIG_VERSION_MISSING'],
    [{ schemaVersion: 2 }, 'CONFIG_VERSION_UNSUPPORTED'],
    [{ schemaVersion: 1, extra: true }, 'CONFIG_SCHEMA'],
    [{ schemaVersion: 1, settings: { 'terminal.integrated.env.linux': { TOKEN: 'private' } } }, 'CONFIG_SECRET_FORBIDDEN'],
    [{ schemaVersion: 1, settings: { 'security.workspace.trust.enabled': false } }, 'CONFIG_SCHEMA'],
    [{ schemaVersion: 1, settings: { 'editor.tabSize': '2' } }, 'CONFIG_SCHEMA'],
    [{ schemaVersion: 1, settings: { 'editor.fontSize': Infinity } }, 'CONFIG_INVALID_VALUE'],
    [JSON.parse('{"schemaVersion":1,"__proto__":{}}'), 'CONFIG_UNSAFE_KEY'],
    [{ schemaVersion: 1, theme: `ghp_${'a'.repeat(30)}` }, 'CONFIG_SECRET_FORBIDDEN'],
  ] as const) {
    assert.throws(() => validateDocument(value, 'profile', 'profile.yml'), rejects(code));
  }
});

test('YAML/JSONC parsers accept intended syntax and reject ambiguous or unsafe inputs without echoing values', () => {
  assert.deepEqual(validateDocument(parseYaml('schemaVersion: 1\ntheme: one-dark\n', 'profile'), 'profile', 'profile'), { schemaVersion: 1, theme: 'one-dark' });
  assert.equal(JSON.stringify(parseJsonc('{/* comment */"editor.tabSize":2,}', 'settings')), '{"editor.tabSize":2}');
  for (const text of ['schemaVersion: 1\nschemaVersion: 2', 'a: &a [1]\nb: *a', 'a: !custom private', '? [DO_NOT_ECHO]\n: value']) {
    assert.throws(() => parseYaml(text, 'input'), rejects('CONFIG_PARSE'));
  }
  assert.throws(() => parseJsonc('{"a":1,"a":2}', 'settings'), rejects('CONFIG_PARSE'));
  assert.throws(() => parseYaml('a'.repeat(MAX_CONFIGURATION_BYTES + 1), 'input'), rejects('CONFIG_LIMIT'));
  try { parseYaml('password: [DO_NOT_ECHO', 'input'); assert.fail('Expected error'); } catch (error) {
    assert.doesNotMatch(String(error), /DO_NOT_ECHO/);
    assert.match(String(error), /input:1:/);
  }
});

test('loaders distinguish absent files, disabled compatibility, invalid inputs and escaping symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-config-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    assert.equal(await loadRepository(repo), undefined);
    await mkdir(join(repo, '.vscode'));
    await writeFile(join(repo, '.vscode/settings.json'), 'invalid');
    assert.equal(await loadCompatibility(repo, false), undefined);
    await assert.rejects(loadCompatibility(repo, true), rejects('CONFIG_PARSE'));
    await writeFile(join(repo, '.vscode/settings.json'), '{ "editor.tabSize": 2, }');
    await writeFile(join(repo, '.vscode/extensions.json'), '{ "recommendations": ["github.copilot"] }');
    assert.deepEqual((await loadCompatibility(repo, true))?.recommendations, ['github.copilot']);
    await mkdir(join(repo, '.vspod'));
    await writeFile(join(root, 'outside.yml'), 'schemaVersion: 1\n');
    await symlink(join(root, 'outside.yml'), join(repo, '.vspod/vspod.yml'));
    await assert.rejects(loadRepository(repo), rejects('CONFIG_PATH_UNSAFE'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded file reads, dangling symlinks and parser depth limits are enforced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-config-limits-'));
  try {
    await mkdir(join(root, '.vspod'));
    const path = join(root, '.vspod/vspod.yml');
    const prefix = 'schemaVersion: 1\n#';
    await writeFile(path, prefix + 'x'.repeat(MAX_CONFIGURATION_BYTES - Buffer.byteLength(prefix)));
    assert.deepEqual(await loadRepository(root), { schemaVersion: 1 });
    await writeFile(path, prefix + 'x'.repeat(MAX_CONFIGURATION_BYTES - Buffer.byteLength(prefix) + 1));
    await assert.rejects(loadRepository(root), rejects('CONFIG_LIMIT'));
    await rm(path);
    await symlink(join(root, 'missing'), path);
    await assert.rejects(loadRepository(root), rejects('CONFIG_PATH_UNSAFE'));
    assert.throws(() => parseJsonc('['.repeat(40) + '1' + ']'.repeat(40), 'settings'), rejects('CONFIG_LIMIT'));
    assert.throws(() => parseYaml('['.repeat(40) + '1' + ']'.repeat(40), 'settings'), rejects('CONFIG_LIMIT'));
    assert.throws(() => validateDocument(parseYaml('schemaVersion: 1\nsettings:\n  editor.fontSize: .nan', 'profile'), 'profile', 'profile'), rejects('CONFIG_INVALID_VALUE'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
