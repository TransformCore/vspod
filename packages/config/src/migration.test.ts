import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigurationError, parseYaml, resolveConfiguration, validateDocument } from './index.ts';
import { planMigration } from './migration.ts';

test('migration preview is deterministic, preserves sources and imports only declared settings and recommendations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-plan-'));
  try {
    await mkdir(join(root, '.vscode'));
    const settings = '{// comment\n"editor.tabSize":2,"editor.rulers":[80,120],"workbench.iconTheme":null,}';
    const extensions = '{"recommendations":["ms-playwright.playwright","dbaeumer.vscode-eslint"]}';
    await writeFile(join(root, '.vscode/settings.json'), settings);
    await writeFile(join(root, '.vscode/extensions.json'), extensions);
    const plan = await planMigration(root);
    assert.deepEqual(plan.definition, {
      schemaVersion: 1,
      settings: { 'editor.rulers': [80, 120], 'editor.tabSize': 2, 'workbench.iconTheme': null },
      extensions: { optional: ['dbaeumer.vscode-eslint', 'ms-playwright.playwright'] },
    });
    assert.equal(plan.yaml, (await planMigration(root)).yaml);
    assert.deepEqual(validateDocument(parseYaml(plan.yaml, 'generated'), 'repository', 'generated'), plan.definition);
    assert.equal(resolveConfiguration({ repository: plan.definition }).accounts.required.length, 0);
    assert.deepEqual(plan.notices, []);
    assert.equal(await readFile(join(root, '.vscode/settings.json'), 'utf8'), settings);
    assert.equal(await readFile(join(root, '.vscode/extensions.json'), 'utf8'), extensions);
    assert.deepEqual(await readdir(root), ['.vscode']);
    assert.equal(plan.sources.length, 2);
    assert.ok(plan.sources.every((source) => /^[a-f0-9]{64}$/.test(source.digest ?? '')));
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('recommendations are optional by default and promotion to required is explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-promotion-'));
  try {
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/extensions.json'), '{"recommendations":["github.copilot","eamodio.gitlens@1.2.3"]}');
    const optional = await planMigration(root);
    assert.deepEqual(optional.definition.extensions, { optional: ['eamodio.gitlens@1.2.3', 'github.copilot'] });
    assert.equal(optional.sources.find((source) => source.path === '.vscode/settings.json')?.digest, null);
    const required = await planMigration(root, { recommendationsAsRequired: true });
    assert.deepEqual(required.definition.extensions, { required: ['eamodio.gitlens@1.2.3', 'github.copilot'] });
    assert.equal(required.definition.settings, undefined);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('unwanted recommendations are applied as import exclusions with an explicit non-portability notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-unwanted-'));
  try {
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/extensions.json'), JSON.stringify({
      recommendations: ['github.copilot', 'eamodio.gitlens@1.2.3'],
      unwantedRecommendations: ['github.copilot', 'eamodio.gitlens'],
    }));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2}');
    const plan = await planMigration(root);
    assert.equal(plan.definition.extensions, undefined);
    assert.equal(plan.notices[0]?.code, 'MIGRATION_IMPORT_EXCLUSIONS');
    assert.match(plan.notices[0]?.message ?? '', /not preserved/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('unsupported, malformed, credential-bearing, empty and conflicting inputs block migration rather than yielding partial output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-invalid-'));
  const check = (code: string) => (error: unknown) =>
    error instanceof ConfigurationError && error.code === code && !String(error).includes('DO_NOT_ECHO');
  try {
    await assert.rejects(planMigration(root), check('MIGRATION_NO_INPUT'));
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/settings.json'), '{}');
    await assert.rejects(planMigration(root), check('MIGRATION_EMPTY_INPUT'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2,"unsupported.setting":"DO_NOT_ECHO"}');
    await assert.rejects(planMigration(root), check('CONFIG_POLICY_DENIED'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2,"password":"DO_NOT_ECHO"}');
    await assert.rejects(planMigration(root), check('CONFIG_SECRET_FORBIDDEN'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2');
    await assert.rejects(planMigration(root), check('CONFIG_PARSE'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2}');
    await writeFile(join(root, '.vscode/extensions.json'), '{"recommendations":["eamodio.gitlens@1.2.3","eamodio.gitlens@2.0.0"]}');
    await assert.rejects(planMigration(root), check('EXTENSION_VERSION_CONFLICT'));
    await writeFile(join(root, '.vscode/extensions.json'), '{"recommendations":["github.copilot"],"other":"DO_NOT_ECHO"}');
    await assert.rejects(planMigration(root), check('CONFIG_SCHEMA'));
  } finally { await rm(root, { force: true, recursive: true }); }
});
