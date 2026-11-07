import { InjectionToken } from '@angular/core';

export interface RuntimeConfig {
  apiBasePath: string;
  projectId: string;
  projectLabel: string;
  schemaIssue: '1.1';
}
export type RuntimeConfigState =
  { config: RuntimeConfig; error?: never } | { config?: never; error: string };
export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfigState>(
  'Organizations runtime configuration',
);

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The connection configuration must be a JSON object.');
  }
  const raw = value as Record<string, unknown>;
  for (const key of ['apiBasePath', 'projectId', 'projectLabel']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) {
      throw new Error(`Set ${key} in organizations.config.json before connecting.`);
    }
  }
  const apiBasePath = (raw['apiBasePath'] as string).trim().replace(/\/+$/, '');
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiBasePath)) {
    throw new Error('apiBasePath must be a same-origin path such as /api.');
  }
  if (raw['schemaIssue'] !== '1.1') throw new Error('This editor supports S3000L Issue 1.1 only.');
  return {
    apiBasePath,
    projectId: (raw['projectId'] as string).trim(),
    projectLabel: (raw['projectLabel'] as string).trim(),
    schemaIssue: '1.1',
  };
}

export async function loadRuntimeConfig(
  fetcher: typeof fetch = fetch,
): Promise<RuntimeConfigState> {
  try {
    const response = await fetcher('organizations.config.json', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok)
      throw new Error(
        'Cannot load organizations.config.json. Configure the connection and reload.',
      );
    return { config: parseRuntimeConfig(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Cannot load the connection configuration.',
    };
  }
}
