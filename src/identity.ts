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

/** GitHub may record a push a moment after the run starts: the record is read this many times, this far apart. */
const RECORD_READS = 6;
const RECORD_WAIT_MS = 10_000;

/**
 * The PR identity check, run by the shared workflow on a pull request. Every
 * commit that claims the agent (its login or its no-reply address) must be
 * Verified as the agent, and pushed by it. Who pushed comes from GitHub's
 * record of the branch's pushes alone, never from whoever started the run,
 * so an edit, a label or a re-run gives the result the push itself gave.
 * Reads the event and repository from the Actions environment and asks
 * GitHub with GH_TOKEN.
 */
export async function prIdentity(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-identity runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
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
  const shas = (list: Commit[]): string => list.map((commit) => commit.sha.slice(0, 7)).join(', ');
  const claim = (list: unknown[]): string => `claim${list.length === 1 ? 's' : ''} ${login}`;
  const head = pull.head.repo?.full_name;
  if (agentCommits.length > 0 && !head) {
    // A deleted fork takes its push record with it.
    problems.push(`#${number}'s head repository is gone, so no record says who pushed ${shas(agentCommits)}, which ${claim(agentCommits)}`);
  } else if (head) {
    const branch = { repo: head, ref: pull.head.ref, base: pull.base.sha, commits: commits.map((commit) => commit.sha) };
    let pushers = new Map<string, string | null>();
    for (let read = 1; agentCommits.length > 0; read++) {
      pushers = await whoPushed(sys, token, branch);
      if (read === RECORD_READS || agentCommits.every((commit) => pushers.has(commit.sha))) break;
      await sys.sleep(RECORD_WAIT_MS);
    }
    const byPusher = new Map<string, Commit[]>();
    const unrecorded: Commit[] = [];
    for (const commit of agentCommits) {
      const pusher = pushers.get(commit.sha);
      if (pusher === undefined) unrecorded.push(commit);
      else if (!pusher || !sameLogin(pusher, login)) {
        const key = pusher ?? 'an account GitHub no longer names';
        byPusher.set(key, [...(byPusher.get(key) ?? []), commit]);
      }
    }
    for (const [pusher, list] of byPusher) {
      problems.push(`${pusher} pushed ${shas(list)}, which ${claim(list)}; agent work must be pushed by ${login}`);
    }
    if (unrecorded.length > 0) {
      problems.push(`no push GitHub has recorded to ${pull.head.ref} brought ${shas(unrecorded)}, which ${claim(unrecorded)}; re-run once GitHub records the push`);
    }
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
 * commits it brought that the pull request still has. A push GitHub records
 * with no actor, such as one by a deleted account, is credited to null.
 */
async function whoPushed(
  sys: Sys,
  token: string,
  branch: { repo: string; ref: string; base: string; commits: string[] },
): Promise<Map<string, string | null>> {
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
  const pushers = new Map<string, string | null>();
  for (const push of pushes.reverse()) {
    if (ZERO.test(push.after)) continue;
    const from = push.activity_type === 'push' && !ZERO.test(push.before) ? push.before : branch.base;
    // Every page of what the push brought, so no commit is left for the fallback.
    for (let page = 1; ; page++) {
      const { status, json } = await sys.http(`${API}/repos/${branch.repo}/compare/${from}...${push.after}?per_page=100&page=${page}`, { token });
      if (status !== 200) throw new Error(`cannot compare ${from.slice(0, 7)}...${push.after.slice(0, 7)} (HTTP ${status})`);
      const brought = (json as { commits?: { sha: string }[] } | null)?.commits ?? [];
      for (const { sha } of brought) {
        if (wanted.has(sha) && !pushers.has(sha)) pushers.set(sha, push.actor?.login ?? null);
      }
      if (brought.length < 100) break;
    }
  }
  return pushers;
}
