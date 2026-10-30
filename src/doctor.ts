import {
  EXPIRY_WARNING_DAYS,
  accountId,
  agentFrom,
  daysLeft,
  keyBody,
  keyPairProblem,
  pathsFor,
  readToken,
  sessionScript,
  signingKeys,
  tokenInfo,
  tokenProblem,
} from './agent.ts';
import type { Output, Sys } from './types.ts';

interface Check {
  name: string;
  /** Undefined when the check passed; otherwise what is wrong. */
  problem: string | undefined;
}

/** Runs a check that reads GitHub; a failed read is that check's problem. */
async function remote(
  name: string,
  check: () => Promise<string | undefined>,
): Promise<Check> {
  try {
    return { name, problem: await check() };
  } catch (error) {
    return { name, problem: `cannot ask GitHub: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Checks that agent sessions on this machine can work as an agent account:
 * signing key, classic token, key registered on GitHub, session file. Exit 1
 * names the `machine` step to re-run; a token near its end is a warning.
 */
export async function doctor(sys: Sys, io: Output, named?: string): Promise<number> {
  const agent = agentFrom(sys, named);
  const paths = pathsFor(sys.home, agent);
  const warnings: string[] = [];

  const keyProblem = keyPairProblem(sys, paths.key);
  const checks: Check[] = [{ name: 'signing key', problem: keyProblem }];

  const token = readToken(sys, agent);
  checks.push(
    await remote('token', async () => {
      if (!token) return `no ${agent} token in this machine's keychain`;
      const info = await tokenInfo(sys, token);
      const problem = tokenProblem(token, info, agent);
      const days = daysLeft(info?.expires, sys.now());
      if (!problem && days !== undefined && days <= EXPIRY_WARNING_DAYS) {
        warnings.push(`the token ends in ${days} days; run process-rules machine to replace it`);
      }
      return problem;
    }),
    await remote('key registered', async () => {
      const registered =
        !keyProblem &&
        (await signingKeys(sys, agent)).includes(keyBody(sys.read(`${paths.key}.pub`)));
      return registered ? undefined : `GitHub does not list this key as a signing key of ${agent}`;
    }),
    await remote('session file', async () => {
      if (!sys.exists(paths.session)) return `${paths.session} is missing`;
      const script = sessionScript(agent, await accountId(sys, agent), paths);
      return sys.read(paths.session) === script ? undefined : `${paths.session} is out of date`;
    }),
  );

  for (const { name, problem } of checks) {
    if (problem) io.err(`✗ ${name}: ${problem}`);
    else io.out(`✓ ${name}`);
  }
  for (const warning of warnings) io.err(`! ${warning}`);
  if (checks.some((check) => check.problem)) {
    io.err(`doctor: agent sessions must not push as ${agent} until fixed; run process-rules machine`);
    return 1;
  }
  io.out(`doctor: ready; agent sessions work as ${agent}`);
  return 0;
}
