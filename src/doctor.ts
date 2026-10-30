import {
  accountId,
  keyBody,
  loadSettings,
  pathsFor,
  readToken,
  repoAt,
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

/**
 * Checks that agent sessions in this repo can work as its agent account:
 * signing key, token, key registered on GitHub, session file. Exit 1 names
 * the `machine` step to re-run.
 */
export async function doctor(sys: Sys, io: Output): Promise<number> {
  const { root } = repoAt(sys);
  const { agent } = loadSettings(sys, root);
  const paths = pathsFor(sys.home, agent);
  const id = await accountId(sys, agent);
  const checks: Check[] = [];

  const hasKey = sys.exists(paths.key) && sys.exists(`${paths.key}.pub`);
  checks.push({
    name: 'signing key',
    problem: hasKey ? undefined : `${paths.key} is missing`,
  });

  const token = readToken(sys, agent);
  const login = token ? await tokenLogin(sys, token) : undefined;
  checks.push({
    name: 'token',
    problem: !token
      ? `no ${agent} token in this machine's keychain`
      : login === undefined
        ? 'GitHub refuses the stored token (expired or revoked?)'
        : login !== agent
          ? `the stored token acts as ${login}, not ${agent}`
          : undefined,
  });

  let registered = false;
  if (hasKey) {
    const local = keyBody(sys.read(`${paths.key}.pub`));
    registered = (await signingKeys(sys, agent)).includes(local);
  }
  checks.push({
    name: 'key registered',
    problem: registered ? undefined : `GitHub does not list this key as a signing key of ${agent}`,
  });

  const script = sessionScript(agent, id, paths);
  const current = sys.exists(paths.session) ? sys.read(paths.session) : undefined;
  checks.push({
    name: 'session file',
    problem:
      current === undefined
        ? `${paths.session} is missing`
        : current !== script
          ? `${paths.session} is out of date`
          : undefined,
  });

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
