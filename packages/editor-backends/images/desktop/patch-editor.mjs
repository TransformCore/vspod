import { readFile, writeFile } from 'node:fs/promises';

const path = '/opt/vscode/resources/app/out/vs/workbench/workbench.desktop.main.js';
const source = await readFile(path, 'utf8');
const anchor = /this\.f=([a-zA-Z_$][\w$]*)\.extUri\.joinPath\(([a-zA-Z_$][\w$]*)\.uri,([a-zA-Z_$][\w$]*)\),this\.g=new ([a-zA-Z_$][\w$]*)\(\2\.uri,\3,/g;
const matches = [...source.matchAll(anchor)];
if (matches.length !== 1) throw new Error('Unsupported desktop editor: folder configuration adapter anchor changed.');
await writeFile(path, source.replace(anchor, (_match, _identity, folder, config, loader) =>
  `this.f=${folder}.uri.with({path:"/vspod/config/workspace",query:"",fragment:""}),this.g=new ${loader}(${folder}.uri,${config},`));
