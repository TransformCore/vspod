import { readFile, writeFile } from 'node:fs/promises';

const path = '/usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js';
const source = await readFile(path, 'utf8');
const original = 'this.f=o.extUri.joinPath(e.uri,t),this.g=new Ngn(e.uri,t,';
if (source.split(original).length !== 2) throw new Error('Unsupported editor build: folder configuration adapter anchor changed.');
// Preserve the remote URI authority, but use VSPod's generated configuration source.
await writeFile(path, source.replace(original,
  'this.f=e.uri.with({path:"/vspod/config/workspace",query:"",fragment:""}),this.g=new Ngn(e.uri,t,'));
