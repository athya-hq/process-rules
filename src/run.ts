import { readFileSync } from 'node:fs';

/** Where the CLI writes; tests pass their own. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `Usage: process-rules <command>

Commands:
  help       Show this text
  version    Print the installed version

More commands arrive as they are built: setup, machine, doctor.`;

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

/** Runs one command and returns its exit code: 0 done, 2 bad usage. */
export function run(args: readonly string[], io: Output): number {
  const [command, ...rest] = args;
  if (rest.length > 0) {
    io.err(`process-rules: unexpected argument "${rest[0]}"`);
    io.err(USAGE);
    return 2;
  }
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      io.out(packageVersion());
      return 0;
    default:
      io.err(`process-rules: unknown command "${command}"`);
      io.err(USAGE);
      return 2;
  }
}
