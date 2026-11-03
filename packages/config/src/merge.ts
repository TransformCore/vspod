import { createHash } from 'node:crypto';
import type {
  CompatibilityInput, ConfigurationSource, ExtensionIntent, ProfileV1,
  RepositoryDefinitionV1, ResolvedConfiguration, Settings,
} from './model.ts';
import { ConfigurationError, validateCompatibilityExtensions, validateDocument, validateSettings } from './validate.ts';

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.formatOnSave': false,
  'files.autoSave': 'off',
  'terminal.integrated.scrollback': 1000,
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function mergeSettings(...layers: readonly Settings[]): Settings {
  const values = new Map<string, Settings[string]>();
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) values.set(key, structuredClone(value));
  return Object.fromEntries([...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function compatibilityRecommendations(input: CompatibilityInput): readonly string[] {
  const unwanted = new Set(input.unwantedRecommendations.map((spec) => spec.split('@')[0]));
  return input.recommendations.filter((spec) => !unwanted.has(spec.split('@')[0]));
}

export function resolveConfiguration(input: {
  profile?: ProfileV1;
  compatibility?: CompatibilityInput;
  repository?: RepositoryDefinitionV1;
} = {}): ResolvedConfiguration {
  const { profile, compatibility, repository } = input;
  if (profile) validateDocument(profile, 'profile', 'profile');
  if (repository) validateDocument(repository, 'repository', 'repository');
  if (compatibility) {
    validateSettings(compatibility.settings, 'compatibility');
    validateCompatibilityExtensions({
      recommendations: compatibility.recommendations,
      unwantedRecommendations: compatibility.unwantedRecommendations,
    }, 'compatibility');
  }
  const layers: [ConfigurationSource, Settings][] = [
    ['defaults', DEFAULT_SETTINGS],
    ['profile', mergeSettings(profile?.theme ? { 'workbench.colorTheme': profile.theme } : {}, profile?.settings ?? {})],
    ['compatibility', compatibility?.settings ?? {}],
    ['repository', repository?.settings ?? {}],
  ];
  const provenance = new Map<string, ConfigurationSource>();
  for (const [source, settings] of layers) for (const key of Object.keys(settings)) provenance.set(key, source);
  const intents = new Map<string, ExtensionIntent>();
  const add = (spec: string, source: ConfigurationSource, required: boolean, selected: boolean) => {
    const [id, version] = spec.split('@');
    const prior = intents.get(id);
    if (prior?.version && version && prior.version !== version) throw new ConfigurationError('EXTENSION_VERSION_CONFLICT', source);
    intents.set(id, {
      id, ...(prior?.version || version ? { version: prior?.version ?? version } : {}),
      required: required || Boolean(prior?.required),
      selected: selected || Boolean(prior?.selected),
      sources: [...new Set([...(prior?.sources ?? []), source])].sort(),
    });
  };
  for (const spec of profile?.extensions ?? []) add(spec, 'profile', false, true);
  for (const spec of compatibility ? compatibilityRecommendations(compatibility) : []) add(spec, 'compatibility', false, false);
  for (const spec of repository?.extensions?.required ?? []) add(spec, 'repository', true, true);
  for (const spec of repository?.extensions?.optional ?? []) add(spec, 'repository', false, false);
  const required = [...new Set(repository?.accounts?.required ?? [])].sort();
  const optional = [...new Set(repository?.accounts?.optional ?? [])].filter((id) => !required.includes(id)).sort();
  const resolved = {
    schemaVersion: 1 as const,
    settings: mergeSettings(...layers.map(([, settings]) => settings)),
    provenance: Object.fromEntries(provenance),
    keybindings: structuredClone(profile?.keybindings ?? []),
    extensions: [...intents.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    accounts: { required, optional },
    startupTasks: [...(repository?.tasks?.startup ?? [])],
  };
  return { ...resolved, fingerprint: createHash('sha256').update(canonical(resolved)).digest('hex') };
}
