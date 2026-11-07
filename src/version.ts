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

/** Whether release `a` comes after release `b`, each major.minor.patch; false when either is not one. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  const at = x.findIndex((part, i) => part !== y[i]);
  return at !== -1 && (x[at] as number) > (y[at] as number);
}
