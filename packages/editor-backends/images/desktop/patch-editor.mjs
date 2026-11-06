import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2] ?? '/opt/vscode/resources/app';
const key = 'vs/workbench/workbench.desktop.main.js';
const path = join(root, 'out', key);
const source = await readFile(path, 'utf8');
const anchor = /this\.f=([a-zA-Z_$][\w$]*)\.extUri\.joinPath\(([a-zA-Z_$][\w$]*)\.uri,([a-zA-Z_$][\w$]*)\),this\.g=new ([a-zA-Z_$][\w$]*)\(\2\.uri,\3,/g;
const matches = [...source.matchAll(anchor)];
if (matches.length !== 1) throw new Error('Unsupported desktop editor: folder configuration adapter anchor changed.');
const productPath = join(root, 'product.json');
const product = JSON.parse(await readFile(productPath, 'utf8'));
const checksum = (content) => createHash('sha256').update(content).digest('base64').replace(/=+$/, '');
if (product.checksums?.[key] !== checksum(source)) {
  throw new Error('Unsupported desktop editor: workbench integrity checksum is missing or does not match.');
}
const patched = source.replace(anchor, (_match, _identity, folder, config, loader) =>
  `this.f=${folder}.uri.with({path:"/vspod/config/workspace",query:"",fragment:""}),this.g=new ${loader}(${folder}.uri,${config},`);
// Record only the intentional build-time transformation; keep runtime integrity checks enabled.
product.checksums[key] = checksum(patched);
await writeFile(path, patched);
await writeFile(productPath, JSON.stringify(product, null, '\t') + '\n');
