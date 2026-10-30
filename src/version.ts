import { readFileSync } from 'node:fs';

/** The version in this package's package.json, from src/ or dist/ alike. */
export function packageVersion(): string {
  return versionOf(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  );
}

/** The string `version` of a parsed package.json; throws without one. */
export function versionOf(raw: unknown): string {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'version' in raw &&
    typeof raw.version === 'string'
  ) {
    return raw.version;
  }
  throw new Error('package.json has no string "version"');
}
