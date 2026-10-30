import {
  accountId,
  keyBody,
  keyPairProblem,
  loadSettings,
  pathsFor,
  readToken,
  repoAt,
  sameLogin,
  sessionScript,
  signingKeys,
  tokenLogin,
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
 * Checks that agent sessions in this repo can work as its agent account:
 * signing key, token, key registered on GitHub, session file. Exit 1 names
 * the `machine` step to re-run.
 */
export async function doctor(sys: Sys, io: Output): Promise<number> {
  const { root } = repoAt(sys);
  const { agent } = loadSettings(sys, root);
  const paths = pathsFor(sys.home, agent);

  const keyProblem = keyPairProblem(sys, paths.key);
  const checks: Check[] = [{ name: 'signing key', problem: keyProblem }];

  const token = readToken(sys, agent);
  checks.push(
    await remote('token', async () => {
      if (!token) return `no ${agent} token in this machine's keychain`;
      const login = await tokenLogin(sys, token);
      if (login === undefined) return 'GitHub refuses the stored token (expired or revoked?)';
      return sameLogin(login, agent) ? undefined : `the stored token acts as ${login}, not ${agent}`;
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
  if (checks.some((check) => check.problem)) {
    io.err(`doctor: agent sessions must not push as ${agent} until fixed; run process-rules machine`);
    return 1;
  }
  io.out(`doctor: ready; agent sessions work as ${agent}`);
  return 0;
}
