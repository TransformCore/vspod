import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('The native VSPod host currently requires macOS.');
const root = fileURLToPath(new URL('../../', import.meta.url));
execFileSync(process.execPath, [join(root, 'packages/app-runner/build.mjs'), '--host'], { stdio: 'inherit' });
const contents = join(root, 'packages/editor-backends/dist/VSPod.app/Contents');
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(contents, 'Resources'), { recursive: true });
await copyFile(join(root, 'packages/app-runner/dist/app-host'), join(contents, 'MacOS/VSPod'));
await copyFile(join(root, 'apps/desktop/src-tauri/icons/icon.icns'), join(contents, 'Resources/icon.icns'));
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VSPod</string>
  <key>CFBundleDisplayName</key><string>VSPod</string>
  <key>CFBundleIdentifier</key><string>dev.vspod.native-host</string>
  <key>CFBundleExecutable</key><string>VSPod</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`);
console.log(`Built ${join(contents, '..')}`);
