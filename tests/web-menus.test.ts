import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CodeServerBackend, CODE_SERVER_ENVIRONMENT } from '@vspod/editor-backends';
import { DockerRuntime } from '@vspod/docker';
import { execute } from '@vspod/core/process';
import { resolveWorkspace } from '@vspod/workspace';

test('system WKWebView displays web menubar dropdowns above split editor panes', {
  skip: process.env.VSPOD_NATIVE_TEST !== '1', timeout: 420_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-web-menus-'));
  const repo = join(root, 'vspod-test-menu');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  await writeFile(join(repo, 'example.ts'), 'export const menuProbe = true;\n');
  const workspace = await resolveWorkspace(repo), runtime = new DockerRuntime(CODE_SERVER_ENVIRONMENT);
  const backend = new CodeServerBackend(runtime);
  try {
    const binary = join(root, 'web-menus');
    await execute('swiftc', [fileURLToPath(new URL('./web-menus.swift', import.meta.url)),
      '-o', binary, '-framework', 'AppKit', '-framework', 'WebKit'], { timeout: 300_000 });
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    await runtime.create(workspace);
    await backend.start(workspace);
    const manifest = { name: 'menu-probe', publisher: 'vspod', version: '0.0.1',
      engines: { vscode: '^1.106.0' }, activationEvents: ['*'], main: './main.cjs' };
    const extension = `
const vscode = require('vscode');
exports.activate = async () => {
  await vscode.workspace.getConfiguration('window').update('menuBarVisibility', 'visible', vscode.ConfigurationTarget.Global);
  const doc = await vscode.workspace.openTextDocument('/workspace/example.ts');
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
};`;
    assert.equal(await runtime.exec(workspace, ['node', '-e',
      `const fs=require('fs');const p='/vspod/extensions/vspod.menu-probe-0.0.1';fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/package.json',${JSON.stringify(JSON.stringify(manifest))});fs.writeFileSync(p+'/main.cjs',${JSON.stringify(extension)});`]), 0);
    await runtime.stop(workspace);
    const session = await backend.start(workspace);
    if (session.presentation.kind !== 'web') throw new Error('Expected web presentation');
    await backend.waitForReady(workspace, session);
    const login = await fetch(session.presentation.origin + '/login', {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: session.presentation.authentication.password }),
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    await login.body?.cancel();
    assert.ok(cookie);
    const separator = cookie.indexOf('=');
    const input = join(root, 'session.json');
    await writeFile(input, JSON.stringify({
      origin: session.presentation.origin, cookieName: cookie.slice(0, separator), cookieValue: cookie.slice(separator + 1),
    }), { mode: 0o600 });
    await execute(binary, [input], { timeout: 80_000 });
    const result = JSON.parse(await readFile(join(root, 'menu-result.json'), 'utf8')) as {
      points: { inside: boolean }[]; editorCount: number; userAgent: string;
      titlebar: { overflow: string; zIndex: string };
    };
    assert.ok(result.editorCount >= 2);
    assert.match(result.userAgent, /AppleWebKit/);
    assert.ok(!result.userAgent.includes('Safari/'), 'Exercise WKWebView, not the upstream Safari-only workaround');
    assert.ok(result.points.length >= 3, 'Dropdown must overlap the editor, not just the explorer sidebar');
    assert.ok(result.points.every((point) => point.inside), 'Editor panes must not cover or intercept the dropdown');
    assert.equal(result.titlebar.overflow, 'visible');
    assert.equal(result.titlebar.zIndex, '2500');
    console.log(`PASS system WKWebView: ${result.points.length} menu hit tests over real split editor panes`);
  } finally {
    if (await runtime.inspect(workspace)) {
      await runtime.remove(workspace);
      await runtime.removeTestVolumes(workspace);
    }
    await rm(root, { recursive: true, force: true });
  }
});
