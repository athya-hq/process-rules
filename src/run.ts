import { readFileSync } from 'node:fs';

import { prDesign } from './design.ts';
import { doctor } from './doctor.ts';
import { prIdentity } from './identity.ts';
import { machine } from './machine.ts';
import { onboard } from './onboard.ts';
import { sessionStart } from './session-start.ts';
import { prePush, prWorkRules } from './work.ts';
import type { Output, Sys } from './types.ts';

export type { Output } from './types.ts';

export const USAGE = `Usage: process-rules <command>

Commands:
  machine [agent]  Set up this machine so agent sessions work as the agent account
  doctor [agent]   Check agent sessions here can work as the agent account
  onboard [owner agent]
                   Set up the client repo here: settings, hook, workflow, agent access, a Verified commit
  session-start    Run by a client's SessionStart hook: the agent identity, or GitHub locked out
  pr-identity      Run by the shared workflow: agent commits Verified and pushed by the agent
  pr-work-rules    Run by the shared workflow: an agent pull request builds one slice it may build
  pr-design        Run by the shared workflow: each state of the slice links a frame from the design library
  pre-push         Run by the pre-push git hook: the same rules before an agent session pushes
  help             Show this text
  version          Print the installed version

Without [agent], machine and doctor use the agent account .github/process-rules.json names
in the repo around the working directory.
onboard needs the owner and agent the first time; after that it reads them from that file.`;

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
  const allowed = command === 'onboard' || command === 'pre-push' ? 2 : command === 'machine' || command === 'doctor' ? 1 : 0;
  const extra = rest[allowed];
  if (extra !== undefined) {
    io.err(`process-rules: unexpected argument "${extra}"`);
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
    case 'session-start':
      return sessionStart(await sys(), io);
    case 'machine':
    case 'doctor':
    case 'onboard':
    case 'pr-identity':
    case 'pr-work-rules':
    case 'pr-design':
    case 'pre-push':
      try {
        if (command === 'pr-design') return await prDesign(await sys(), io);
        if (command === 'pr-identity') return await prIdentity(await sys(), io);
        if (command === 'pr-work-rules') return await prWorkRules(await sys(), io);
        if (command === 'pre-push') {
          const real = await sys();
          return await prePush(real, io, real.readStdin());
        }
        if (command === 'onboard') return await onboard(await sys(), io, rest);
        return await (command === 'machine' ? machine : doctor)(await sys(), io, rest[0]);
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
