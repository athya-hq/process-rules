import { API, account, loadSettings, noreplyEmail, sameLogin } from './agent.ts';
import type { Output, Sys } from './types.ts';

interface Commit {
  sha: string;
  author?: { login?: string } | null;
  committer?: { login?: string } | null;
  commit?: { author?: { email?: string }; verification?: { verified?: boolean; reason?: string } };
}

/** GitHub lists at most 250 commits for a pull request. */
const MOST_COMMITS = 250;

/**
 * The PR identity check, run by the shared workflow on a pull request. Every
 * commit that claims the agent (its login or its no-reply address) must be
 * Verified as the agent; and when this push or opening brought agent commits,
 * the account that triggered it must be the agent, so agent work pushed with
 * the owner's login fails. Reads the event, actor and repository from the
 * Actions environment and asks GitHub with GH_TOKEN.
 */
export async function prIdentity(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_ACTOR: actor, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !actor || !slug || !token) {
    throw new Error('pr-identity runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_ACTOR, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as { action?: string; before?: string; pull_request?: { number?: number } };
  const number = event.pull_request?.number;
  if (typeof number !== 'number') {
    io.out('pr-identity: not a pull request; nothing to check');
    return 0;
  }
  const { agent } = loadSettings(sys, sys.cwd);
  const { id, login } = await account(sys, agent);
  const email = noreplyEmail(id, login).toLowerCase();

  const commits: Commit[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/pulls/${number}/commits?per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list the commits of #${number} (HTTP ${status})`);
    commits.push(...(json as Commit[]));
    if (json.length < 100 || commits.length >= MOST_COMMITS) break;
  }
  if (commits.length >= MOST_COMMITS) {
    // Commits past GitHub's limit cannot be seen, so they cannot pass.
    io.err(`✗ #${number} has ${MOST_COMMITS} or more commits, more than GitHub lists; split it so every commit can be checked`);
    io.err(`pr-identity: #${number} fails the identity check`);
    return 1;
  }

  const claimsAgent = (commit: Commit): boolean =>
    sameLogin(commit.author?.login ?? undefined, login) || commit.commit?.author?.email?.toLowerCase() === email;
  const problems: string[] = [];
  for (const commit of commits.filter(claimsAgent)) {
    const verification = commit.commit?.verification;
    if (verification?.verified !== true || !sameLogin(commit.committer?.login ?? undefined, login)) {
      problems.push(
        `${commit.sha.slice(0, 7)} claims ${login} but is not Verified as ${login} (committer ${commit.committer?.login ?? 'none'}, ${verification?.reason ?? 'no verification'})`,
      );
    }
  }
  // Only opening and pushing bring commits: on a push, those after the old
  // head (all of them after a force push); reopening or editing brings none.
  const before = event.action === 'synchronize' ? commits.findIndex((commit) => commit.sha === event.before) : -1;
  const pushed = event.action === 'opened' || event.action === 'synchronize' ? commits.slice(before + 1) : [];
  if (pushed.some(claimsAgent) && !sameLogin(actor, login)) {
    problems.push(`${actor} pushed commits that claim ${login}; agent work must be pushed by ${login}`);
  }

  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length > 0) {
    io.err(`pr-identity: #${number} fails the identity check`);
    return 1;
  }
  const count = commits.filter(claimsAgent).length;
  io.out(`✓ pr-identity: ${count} commit${count === 1 ? '' : 's'} by ${login}, each Verified; pushed by ${actor}`);
  return 0;
}
