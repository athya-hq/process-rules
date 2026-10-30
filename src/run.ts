import { readFileSync } from 'node:fs';

import { doctor } from './doctor.ts';
import { machine } from './machine.ts';
import type { Output, Sys } from './types.ts';

export type { Output } from './types.ts';

export const USAGE = `Usage: process-rules <command>

Commands:
  machine    Set up this machine so agent sessions work as the agent account
  doctor     Check agent sessions here can work as the agent account
  help       Show this text
  version    Print the installed version

Both read the agent account from .github/process-rules.json in the repo.
More commands arrive as they are built: onboard.`;

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

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 bad usage. */
export async function run(
  args: readonly string[],
  io: Output,
  sys: () => Sys | Promise<Sys>,
): Promise<number> {
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
    case 'machine':
    case 'doctor':
      try {
        return await (command === 'machine' ? machine : doctor)(await sys(), io);
      } catch (error) {
        io.err(`process-rules ${command}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    default:
      io.err(`process-rules: unknown command "${command}"`);
      io.err(USAGE);
      return 2;
  }
}
