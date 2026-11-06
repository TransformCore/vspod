import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = join(process.argv[2] ?? '/usr/lib/code-server/lib/vscode', 'out/vs/code/browser/workbench');
const path = join(directory, 'workbench.js');
const source = await readFile(path, 'utf8');
const original = 'this.f=o.extUri.joinPath(e.uri,t),this.g=new Ngn(e.uri,t,';
if (source.split(original).length !== 2) throw new Error('Unsupported editor build: folder configuration adapter anchor changed.');
const stylesPath = join(directory, 'workbench.css');
const styles = await readFile(stylesPath, 'utf8');
for (const anchor of ['.monaco-workbench .part.titlebar{', '.monaco-workbench .part.titlebar>.titlebar-container{']) {
  if (styles.split(anchor).length !== 2) throw new Error('Unsupported editor build: titlebar stylesheet anchor changed.');
}
const overrides = await readFile(new URL('./workbench-overrides.css', import.meta.url), 'utf8');
// Preserve the remote URI authority, but use VSPod's generated configuration source.
await writeFile(path, source.replace(original,
  'this.f=e.uri.with({path:"/vspod/config/workspace",query:"",fragment:""}),this.g=new Ngn(e.uri,t,'));
await writeFile(stylesPath, `${styles}\n${overrides}`);
