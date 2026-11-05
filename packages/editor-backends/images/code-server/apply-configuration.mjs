import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

export async function applyConfiguration(configuration) {
  if (configuration?.schemaVersion !== 1 || typeof configuration.fingerprint !== 'string' ||
      !configuration.settings || typeof configuration.settings !== 'object' ||
      !Array.isArray(configuration.keybindings)) throw new Error('Invalid runtime configuration.');
  for (const directory of ['/vspod/settings', '/vspod/config/workspace']) {
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe managed configuration directory.');
  }
  async function atomic(path, value) {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.pending`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  let settings = {};
  try { settings = JSON.parse(await readFile('/vspod/settings/settings.json', 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Existing editor settings cannot be safely reconciled.');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid existing editor settings.');
  let previous;
  try { previous = JSON.parse(await readFile('/vspod/config/applied.json', 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Invalid applied configuration metadata.');
  }
  for (const key of previous?.managedKeys ?? []) delete settings[key];
  await atomic('/vspod/settings/settings.json', {
    ...settings, ...configuration.settings,
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  });
  if (configuration.keybindings.length || previous?.managedKeybindings?.length) {
    let existing = [];
    try { existing = JSON.parse(await readFile('/vspod/settings/keybindings.json', 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Existing keybindings cannot be safely reconciled.');
    }
    if (!Array.isArray(existing)) throw new Error('Existing keybindings must be an array.');
    const prior = new Set((previous?.managedKeybindings ?? []).map((binding) => JSON.stringify(binding)));
    await atomic('/vspod/settings/keybindings.json', [
      ...existing.filter((binding) => !prior.has(JSON.stringify(binding))), ...configuration.keybindings,
    ]);
  }
  await atomic('/vspod/config/workspace/settings.json', configuration.settings);
  await atomic('/vspod/config/runtime-mode.json', { restricted: configuration.restricted === true });
  await atomic('/vspod/config/applied.json', {
    schemaVersion: 1, fingerprint: configuration.fingerprint,
    managedKeys: Object.keys(configuration.settings),
    managedKeybindings: configuration.keybindings,
  });
}
