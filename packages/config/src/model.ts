export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Settings = Readonly<Record<string, JsonValue>>;
export type ProviderId = 'github' | 'azure' | 'github-copilot' | 'salesforce' | 'aws';
export type ConfigurationSource = 'defaults' | 'profile' | 'compatibility' | 'repository';

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
}

export interface ProfileV1 {
  schemaVersion: 1;
  name?: string;
  theme?: string;
  settings?: Settings;
  extensions?: readonly string[];
  keybindings?: readonly Keybinding[];
}

export interface RepositoryDefinitionV1 {
  schemaVersion: 1;
  name?: string;
  settings?: Settings;
  extensions?: { required?: readonly string[]; optional?: readonly string[] };
  accounts?: { required?: readonly ProviderId[]; optional?: readonly ProviderId[] };
  tasks?: { startup?: readonly string[] };
}

export interface CompatibilityInput {
  settings: Settings;
  recommendations: readonly string[];
  unwantedRecommendations: readonly string[];
}

export interface ExtensionIntent {
  id: string;
  version?: string;
  required: boolean;
  selected: boolean;
  sources: readonly ConfigurationSource[];
}

export interface ResolvedConfiguration {
  schemaVersion: 1;
  settings: Settings;
  provenance: Readonly<Record<string, ConfigurationSource>>;
  keybindings: readonly Keybinding[];
  extensions: readonly ExtensionIntent[];
  accounts: { required: readonly ProviderId[]; optional: readonly ProviderId[] };
  startupTasks: readonly string[];
  fingerprint: string;
}
