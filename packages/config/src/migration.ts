import { stringify } from 'yaml';
import { ConfigurationError, validateDocument } from './validate.ts';
import { loadCompatibilitySnapshot, parseYaml } from './load.ts';
import type { CompatibilitySnapshot } from './load.ts';
import type { RepositoryDefinitionV1 } from './model.ts';
import { compatibilityRecommendations, resolveConfiguration } from './merge.ts';

export interface MigrationOptions {
  recommendationsAsRequired?: boolean;
}

export interface MigrationPlan {
  schemaVersion: 1;
  recommendationsAsRequired: boolean;
  definition: RepositoryDefinitionV1;
  yaml: string;
  sources: CompatibilitySnapshot['sources'];
  notices: readonly { code: string; message: string }[];
}

export async function planMigration(root: string, options: MigrationOptions = {}): Promise<MigrationPlan> {
  const { input, sources } = await loadCompatibilitySnapshot(root);
  if (sources.every((source) => source.digest === null)) {
    throw new ConfigurationError('MIGRATION_NO_INPUT', '.vscode');
  }
  const settings = Object.fromEntries(Object.entries(input.settings).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const extensions = [...compatibilityRecommendations(input)].sort();
  if (!Object.keys(settings).length && !extensions.length) {
    throw new ConfigurationError('MIGRATION_EMPTY_INPUT', '.vscode');
  }
  const definition: RepositoryDefinitionV1 = {
    schemaVersion: 1,
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(extensions.length ? {
      extensions: options.recommendationsAsRequired ? { required: extensions } : { optional: extensions },
    } : {}),
  };
  validateDocument(definition, 'repository', '.vspod/vspod.yml');
  resolveConfiguration({ repository: definition });
  const yaml = stringify(definition, { lineWidth: 0 });
  validateDocument(parseYaml(yaml, '.vspod/vspod.yml'), 'repository', '.vspod/vspod.yml');
  return {
    schemaVersion: 1,
    recommendationsAsRequired: options.recommendationsAsRequired ?? false,
    definition,
    yaml,
    sources,
    notices: input.unwantedRecommendations.length ? [{
      code: 'MIGRATION_IMPORT_EXCLUSIONS',
      message: 'unwantedRecommendations were applied as import exclusions only; negative rules are not preserved in .vspod. The source files remain unchanged.',
    }] : [],
  };
}
