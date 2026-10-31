import { API, sameLogin } from './agent.ts';
import type { Sys } from './types.ts';

/** SSH as git reads a URL: an SSH scheme, or the scp-like `[user@]host:path`. */
const SSH = /^(?:(?:ssh|git\+ssh|ssh\+git):\/\/|[^/:\s]+:(?!\/\/))/i;
const HTTPS_GITHUB = /^https:\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\//i;

/**
 * Whether this shell is an agent session's on this Mac: one session-start
 * gave the agent identity, or any shell Claude Code runs (it sets
 * CLAUDECODE), so a session whose hooks never ran is one too. Cloud sessions
 * are left alone; they reach GitHub as the account connected to them.
 */
export function agentSession(sys: Sys): boolean {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') return false;
  return !!sys.env.PROCESS_RULES_AGENT || sys.env.CLAUDECODE === '1';
}

/**
 * Why an agent session's push to `url` would not reach GitHub as `agent`, or
 * undefined when it would, or when `url` is neither SSH nor GitHub. Any push
 * over SSH is refused, whatever the host, since a host alias can be GitHub:
 * it uses this Mac's keys, which are the owner's, and the agent's identity
 * sends GitHub over HTTPS. Over HTTPS the credentials git would push with,
 * one in the URL included, are asked of git itself, then of GitHub.
 */
export async function pushIdentityProblem(sys: Sys, root: string, url: string, agent: string): Promise<string | undefined> {
  const notSetUp = 'this session was not given the agent identity, which sends GitHub over HTTPS; tell the owner';
  if (!url) return 'git gave the pre-push hook no remote URL, so this push cannot be checked';
  if (SSH.test(url)) {
    return `this push goes over SSH, with this Mac's SSH keys, which are its owner's, not ${agent}'s: ${notSetUp}`;
  }
  if (!HTTPS_GITHUB.test(url)) return undefined;
  const filled = sys.exec('git', ['credential', 'fill'], {
    cwd: root,
    // The whole URL, so a user or password in it is the one checked, as git would push with it.
    input: `url=${url}\n\n`,
    // Never a prompt: an empty askpass is no program, and the terminal prompt is off.
    env: { ...sys.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    timeoutMs: 20_000,
  });
  const password = /^password=(.*)$/m.exec(filled.stdout)?.[1];
  if (filled.code !== 0 || !password) {
    return `git has no credentials for github.com here, so this push cannot reach GitHub as ${agent}: ${notSetUp}`;
  }
  let login: unknown;
  try {
    const { status, json } = await sys.http(`${API}/user`, { token: password });
    login = status === 200 ? (json as { login?: unknown } | null)?.login : undefined;
  } catch (error) {
    return `GitHub cannot be asked who this push is from (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof login !== 'string') {
    return `GitHub does not accept the credentials git would push with, so this push cannot reach GitHub as ${agent}: ${notSetUp}`;
  }
  if (!sameLogin(login, agent)) {
    return `this push would reach GitHub as ${login}, not ${agent}; agent sessions push only as ${agent}: ${notSetUp}`;
  }
  return undefined;
}
