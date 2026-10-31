import { API, account, loadSettings, noreplyEmail, sameLogin } from './agent.ts';
import { isOn, notAdoptedLine, offLine } from './features.ts';
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
 * Verified as the agent, and pushed by it: GitHub's record of the branch's
 * pushes names who brought each commit, so agent work pushed with the
 * owner's login fails on every later run too, whatever started it. Reads the
 * event, actor and repository from the Actions environment and asks GitHub
 * with GH_TOKEN.
 */
export async function prIdentity(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_ACTOR: actor, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !actor || !slug || !token) {
    throw new Error('pr-identity runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_ACTOR, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    action?: string;
    pull_request?: { number?: number; base?: { sha: string }; head?: { ref: string; repo: { full_name: string } | null } };
  };
  const pull = event.pull_request;
  const number = pull?.number;
  if (typeof number !== 'number' || !pull?.base || !pull.head) {
    io.out('pr-identity: not a pull request; nothing to check');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-identity');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  const { agent } = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'pr-identity')) {
    io.out(offLine('pr-identity', 'pr-identity'));
    return 0;
  }
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
  // Only commits that claim the agent need their pusher; an owner-only pull request asks GitHub nothing more.
  const agentCommits = commits.filter(claimsAgent);
  const pushers = agentCommits.length === 0 ? new Map<string, string>() : await whoPushed(sys, token, {
    repo: pull.head.repo?.full_name ?? slug,
    ref: pull.head.ref,
    base: pull.base.sha,
    commits: commits.map((commit) => commit.sha),
  });
  // A run started by opening or pushing knows who brought the newest commits even
  // before GitHub records the push; any other run relies on the record alone.
  const fallback = event.action === 'opened' || event.action === 'synchronize' ? actor : undefined;
  const byPusher = new Map<string, string[]>();
  for (const commit of agentCommits) {
    const pusher = pushers.get(commit.sha) ?? fallback;
    if (pusher && sameLogin(pusher, login)) continue;
    const key = pusher ?? 'an account GitHub has not recorded yet';
    byPusher.set(key, [...(byPusher.get(key) ?? []), commit.sha.slice(0, 7)]);
  }
  for (const [pusher, shas] of byPusher) {
    problems.push(`${pusher} pushed ${shas.join(', ')}, which claim${shas.length === 1 ? 's' : ''} ${login}; agent work must be pushed by ${login}`);
  }

  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length > 0) {
    io.err(`pr-identity: #${number} fails the identity check`);
    return 1;
  }
  const count = commits.filter(claimsAgent).length;
  io.out(`✓ pr-identity: ${count} commit${count === 1 ? '' : 's'} by ${login}, each Verified and pushed by ${login}`);
  return 0;
}

const ZERO = /^0+$/;

/**
 * Who pushed each of a pull request's commits, from GitHub's record of the
 * pushes to its branch, oldest first: each push is credited with the
 * commits it brought that the pull request still has.
 */
async function whoPushed(
  sys: Sys,
  token: string,
  branch: { repo: string; ref: string; base: string; commits: string[] },
): Promise<Map<string, string>> {
  const pushes: { before: string; after: string; activity_type: string; actor: { login: string } | null }[] = [];
  // The activity list pages by cursor: each reply's Link header names the next page.
  const ref = encodeURIComponent(`refs/heads/${branch.ref}`);
  for (let url: string | undefined = `${API}/repos/${branch.repo}/activity?ref=${ref}&per_page=100`; url; ) {
    const { status, json, headers = {} } = await sys.http(url, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read the pushes to ${branch.ref} (HTTP ${status})`);
    pushes.push(...(json as typeof pushes));
    url = /<([^>]+)>;\s*rel="next"/.exec(headers.link ?? '')?.[1];
  }
  const wanted = new Set(branch.commits);
  const pushers = new Map<string, string>();
  for (const push of pushes.reverse()) {
    if (ZERO.test(push.after) || !push.actor) continue;
    const from = push.activity_type === 'push' && !ZERO.test(push.before) ? push.before : branch.base;
    // Every page of what the push brought, so no commit is left for the fallback.
    for (let page = 1; ; page++) {
      const { status, json } = await sys.http(`${API}/repos/${branch.repo}/compare/${from}...${push.after}?per_page=100&page=${page}`, { token });
      if (status !== 200) throw new Error(`cannot compare ${from.slice(0, 7)}...${push.after.slice(0, 7)} (HTTP ${status})`);
      const brought = (json as { commits?: { sha: string }[] } | null)?.commits ?? [];
      for (const { sha } of brought) {
        if (wanted.has(sha) && !pushers.has(sha)) pushers.set(sha, push.actor.login);
      }
      if (brought.length < 100) break;
    }
  }
  return pushers;
}
