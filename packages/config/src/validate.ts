import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../schemas/config-v1.schema.json' with { type: 'json' };
import type { ProfileV1, RepositoryDefinitionV1, Settings } from './model.ts';

export class ConfigurationError extends Error {
  get hint(): string {
    if (this.code === 'MIGRATION_NO_INPUT') return 'Add .vscode/settings.json or .vscode/extensions.json, then retry vspod migrate. No definition was generated.';
    if (this.code === 'MIGRATION_EMPTY_INPUT') return 'The supported inputs contain no settings or remaining recommendations to import. No definition was generated.';
    return 'Correct the input using the VSPod v1 configuration schema, then retry vspod config explain. Never put credentials in configuration.';
  }
  constructor(
    public readonly code: string,
    public readonly source: string,
    public readonly pointer = '',
    public readonly line?: number,
    public readonly column?: number,
  ) {
    // Neither parser messages nor invalid values are safe to echo.
    super(`${code}: configuration rejected at ${source}${line ? `:${line}:${column}` : ''}${pointer ? ` (${pointer})` : ''}.`);
    this.name = 'ConfigurationError';
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(schema);
const profileValidator = ajv.compile<ProfileV1>({ $ref: 'urn:vspod:config:v1#/$defs/profile' });
const repositoryValidator = ajv.compile<RepositoryDefinitionV1>({ $ref: 'urn:vspod:config:v1#/$defs/repository' });
const settingsValidator = ajv.compile<Settings>({ $ref: 'urn:vspod:config:v1#/$defs/settings' });
const extensionsValidator = ajv.compile<string[]>({ $ref: 'urn:vspod:config:v1#/$defs/extensions' });

function inspect(value: unknown, source: string, depth = 0): void {
  if (depth > 32) throw new ConfigurationError('CONFIG_LIMIT', source);
  if (typeof value === 'string') {
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/.test(value)) {
      throw new ConfigurationError('CONFIG_SECRET_FORBIDDEN', source);
    }
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfigurationError('CONFIG_INVALID_VALUE', source);
  } else if (Array.isArray(value)) {
    if (value.length > 1024) throw new ConfigurationError('CONFIG_LIMIT', source);
    for (const item of value) inspect(item, source, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new ConfigurationError('CONFIG_INVALID_VALUE', source);
    }
    if (Object.keys(value).length > 1024) throw new ConfigurationError('CONFIG_LIMIT', source);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ConfigurationError('CONFIG_UNSAFE_KEY', source);
      if (/(?:^|[._-])(?:tokens?|passwords?|refreshTokens?|secrets?|credentials?|certificates?)(?:$|[._-])/i.test(key)) {
        throw new ConfigurationError('CONFIG_SECRET_FORBIDDEN', source);
      }
      inspect(item, source, depth + 1);
    }
  } else if (value !== null && typeof value !== 'boolean') {
    throw new ConfigurationError('CONFIG_INVALID_VALUE', source);
  }
}

export function validateDocument(value: unknown, kind: 'profile', source: string): ProfileV1;
export function validateDocument(value: unknown, kind: 'repository', source: string): RepositoryDefinitionV1;
export function validateDocument(value: unknown, kind: 'profile' | 'repository', source: string): ProfileV1 | RepositoryDefinitionV1 {
  inspect(value, source);
  if (value === null || typeof value !== 'object' || !('schemaVersion' in value)) {
    throw new ConfigurationError('CONFIG_VERSION_MISSING', source);
  }
  if (value.schemaVersion !== 1) throw new ConfigurationError('CONFIG_VERSION_UNSUPPORTED', source, '/schemaVersion');
  if (kind === 'profile') {
    if (!profileValidator(value)) throw new ConfigurationError('CONFIG_SCHEMA', source, profileValidator.errors?.[0]?.instancePath);
    return value;
  }
  if (!repositoryValidator(value)) throw new ConfigurationError('CONFIG_SCHEMA', source, repositoryValidator.errors?.[0]?.instancePath);
  return value;
}

export function validateSettings(value: unknown, source: string): Settings {
  inspect(value, source);
  if (!settingsValidator(value)) throw new ConfigurationError('CONFIG_POLICY_DENIED', source, settingsValidator.errors?.[0]?.instancePath);
  return value;
}

export function validateCompatibilityExtensions(value: unknown, source: string): {
  recommendations: readonly string[];
  unwantedRecommendations: readonly string[];
} {
  inspect(value, source);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['recommendations', 'unwantedRecommendations'].includes(key))) {
    throw new ConfigurationError('CONFIG_SCHEMA', source);
  }
  const recommendations = 'recommendations' in value ? value.recommendations : [];
  const unwantedRecommendations = 'unwantedRecommendations' in value ? value.unwantedRecommendations : [];
  if (!extensionsValidator(recommendations)) throw new ConfigurationError('CONFIG_SCHEMA', source);
  if (!extensionsValidator(unwantedRecommendations)) throw new ConfigurationError('CONFIG_SCHEMA', source);
  return { recommendations, unwantedRecommendations };
}
