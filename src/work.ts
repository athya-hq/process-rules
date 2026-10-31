import { API, NO_TOKEN, loadSettings, repoAt, sameLogin } from './agent.ts';
import { isOn, notAdoptedLine, offLine } from './features.ts';
import { agentSession, pushIdentityProblem } from './push-identity.ts';
import { cloudToken } from './cloud.ts';
import type { Output, Sys } from './types.ts';

/** How a pull request or a commit names the slice it builds. */
const SLICE_LINE = /^Slice:\s*(?:#|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)(\d+)\s*$/gim;

/** The slices `text` names, in order, without repeats. */
export function slicesNamed(text: string): number[] {
  return [...new Set([...text.matchAll(SLICE_LINE)].map((match) => Number(match[1])))];
}

interface Comment {
  id: number | string;
  user: { login: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Issue {
  number: number;
  title: string;
  /** The issue's address in GitHub's REST API, from which its comments, sub-issues and timeline are read. */
  url: string;
  type: { name: string } | null;
  state_reason: string | null;
  closed_at: string | null;
  parent_issue_url?: string | null;
  pull_request?: unknown;
}

type TimelineEvent =
  | { event: 'labeled' | 'unlabeled'; created_at: string; actor: { login: string } | null; label: { name: string } }
  | { event: 'sub_issue_added'; created_at: string; sub_issue: { number: number } | null }
  | ({ event: 'commented' } & Comment)
  | { event: 'other' };

interface Reaction {
  user: { login: string } | null;
  created_at: string;
}

/**
 * Reads `url` from GitHub's REST API for slice `slice`'s work rules: its
 * JSON, or undefined on 404 when `missing` allows it. The work rules read
 * REST alone, so they run wherever GitHub's REST API answers, a Claude
 * cloud session's GitHub proxy included, which refuses GraphQL.
 */
async function rest(sys: Sys, token: string, slice: number, url: string, missing = false): Promise<unknown> {
  const { status, json } = await sys.http(url, { token });
  if (status === 404 && missing) return undefined;
  if (status !== 200) {
    const why = (json as { message?: string } | null)?.message ?? `HTTP ${status}`;
    // A client workflow from before the work rules grants no issues: read.
    const hint = /not accessible/i.test(why) ? '; the client workflow needs issues: read, so run process-rules onboard to update it' : '';
    throw new Error(`cannot read #${slice}: ${why} (${url.replace(API, '')})${hint}`);
  }
  return json;
}

/** Every item of a REST list at `url`, 100 a page: GitHub's most. */
async function every<T>(sys: Sys, token: string, slice: number, url: string, missing = false): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const json = await rest(sys, token, slice, `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, missing);
    if (json === undefined) return items;
    if (!Array.isArray(json)) throw new Error(`cannot read #${slice}: GitHub did not answer a list (${url.replace(API, '')})`);
    items.push(...(json as T[]));
    if (json.length < 100) return items;
  }
}

/** When a comment was last edited, or undefined: GitHub moves `updated_at` on an edit, not on a reaction. */
const editedAt = (comment: Comment): string | undefined => (comment.updated_at > comment.created_at ? comment.updated_at : undefined);

/** Whether the owner left a `Decision:` comment among `comments`, after `since` when given, mentioning `mention` when given. */
function decided(comments: Comment[], owner: string, since?: string, mention?: string): boolean {
  return comments.some(
    (comment) =>
      sameLogin(comment.user?.login, owner) &&
      /^\s*Decision:/i.test(comment.body) &&
      (!since || comment.created_at > since) &&
      (!mention || new RegExp(`${mention}\\b`).test(comment.body)),
  );
}

/** A proposal's first line, and the issue it names first: what the proposal is for. */
const PROPOSAL = /^\s*Proposal:[^#\n]*#(\d+)\b/i;

/** The agent's proposals among `comments` for issue `number`. */
function proposalsFor(comments: Comment[], agent: string, number: number): Comment[] {
  return comments.filter((comment) => sameLogin(comment.user?.login, agent) && Number(PROPOSAL.exec(comment.body)?.[1]) === number);
}

/** A decision the owner owes a slice: its addition after the work item's approval, or a state dropped after it. */
interface Owed {
  kind: 'added' | 'dropped';
  /** The slice, when it was added; the state, when it was dropped. */
  number: number;
  title: string;
  /** The owner's say counts only after this, when given: the slice's latest addition. */
  since?: string;
  /** The agent's proposals for it, on the slice. */
  proposals: Comment[];
  /** Whether the owner gave it: a `Decision:` comment, or 👍 on one of the proposals. */
  settled: boolean;
}

/**
 * Whether the owner reacted 👍 to one of `proposals`, after `since` when
 * given and after the proposal's last edit, from the reactions read by id.
 */
function thumbsUp(proposals: Comment[], reactions: Map<Comment['id'], Reaction[]>, owner: string, since?: string): boolean {
  return proposals.some((proposal) =>
    (reactions.get(proposal.id) ?? []).some((reaction) => {
      const edited = editedAt(proposal);
      return sameLogin(reaction.user?.login, owner) && (!since || reaction.created_at > since) && (!edited || reaction.created_at > edited);
    }),
  );
}

/** Issue `number` of `slug`, or undefined when there is none (a pull request is not one). */
async function readIssue(sys: Sys, token: string, slug: string, number: number): Promise<Issue | undefined> {
  const issue = (await rest(sys, token, number, `${API}/repos/${slug}/issues/${number}`, true)) as Issue | undefined;
  return issue && !issue.pull_request ? issue : undefined;
}

/** The issue `issue` is a sub-issue of, or undefined. */
async function parentOf(sys: Sys, token: string, slice: number, issue: Issue): Promise<Issue | undefined> {
  return issue.parent_issue_url ? ((await rest(sys, token, slice, issue.parent_issue_url, true)) as Issue | undefined) : undefined;
}

/**
 * Reads slice `slice` against the work rules' approvals: the problems that
 * stop it outright (not a Slice under a Work item the owner approved), else
 * the decisions it owes the owner and whether each was given.
 */
async function readSlice(
  sys: Sys,
  token: string,
  slug: string,
  slice: number,
  { owner, agent }: { owner: string; agent: string },
): Promise<{ problems: string[]; parent?: number; owed: Owed[] }> {
  const issue = await readIssue(sys, token, slug, slice);
  if (!issue) return { problems: [`#${slice} is not an issue in ${slug}`], owed: [] };
  if (issue.type?.name !== 'Slice') return { problems: [`#${slice} is not a Slice (its type is ${issue.type?.name ?? 'none'})`], owed: [] };
  const parent = await parentOf(sys, token, slice, issue);
  if (parent?.type?.name !== 'Work item') return { problems: [`#${slice} is not a sub-issue of a Work item`], owed: [] };

  const events = await every<TimelineEvent>(sys, token, slice, `${parent.url}/timeline`);
  const approval = events
    .filter((event): event is Extract<TimelineEvent, { event: 'labeled' | 'unlabeled' }> => (event.event === 'labeled' || event.event === 'unlabeled') && event.label.name === 'approved')
    .at(-1);
  if (approval?.event !== 'labeled') {
    return { problems: [`work item #${parent.number} is not approved: ${owner} adds the approved label before any slice starts`], owed: [] };
  }
  if (!sameLogin(approval.actor?.login, owner)) {
    return { problems: [`work item #${parent.number} was labeled approved by ${approval.actor?.login ?? 'someone unknown'}, not ${owner}`], owed: [] };
  }
  const approvedAt = approval.created_at;
  const parentComments = events.filter((event): event is { event: 'commented' } & Comment => event.event === 'commented');
  // Every comment on the slice, so a proposal or decision that later discussion pushed back still counts.
  const comments = await every<Comment>(sys, token, slice, `${issue.url}/comments`);
  // Every state, however many: one past the first page can be a dropped one.
  const states = await every<Issue>(sys, token, slice, `${issue.url}/sub_issues`);

  const owed: Owed[] = [];
  // The latest addition counts: a slice removed and added again after approval needs the owner's say.
  const added = events
    .filter((event): event is Extract<TimelineEvent, { event: 'sub_issue_added' }> => event.event === 'sub_issue_added' && event.sub_issue?.number === slice)
    .at(-1);
  if (added && added.created_at > approvedAt) {
    owed.push({
      kind: 'added',
      number: slice,
      title: issue.title,
      since: added.created_at,
      proposals: proposalsFor(comments, agent, slice),
      settled: decided(parentComments, owner, added.created_at, `#${slice}`) || decided(comments, owner, added.created_at),
    });
  }
  for (const state of states) {
    if (state.type?.name !== 'State' || state.state_reason !== 'not_planned' || !state.closed_at || state.closed_at < approvedAt) continue;
    owed.push({
      kind: 'dropped',
      number: state.number,
      title: state.title,
      proposals: proposalsFor(comments, agent, state.number),
      settled: decided(comments, owner, undefined, `#${state.number}`) || decided(await every<Comment>(sys, token, slice, `${state.url}/comments`), owner),
    });
  }

  // Reactions are read only for the proposals that could still settle something; a deleted proposal has none.
  const reactions = new Map<Comment['id'], Reaction[]>();
  for (const proposal of owed.filter((one) => !one.settled).flatMap((one) => one.proposals)) {
    reactions.set(proposal.id, await every<Reaction>(sys, token, slice, `${API}/repos/${slug}/issues/comments/${proposal.id}/reactions?content=%2B1`, true));
  }
  for (const one of owed) one.settled ||= thumbsUp(one.proposals, reactions, owner, one.since);
  return { problems: [], parent: parent.number, owed };
}

/** Why `owed` stops slice `slice`, and how the owner settles it. */
function owedProblem(one: Owed, slice: number, parent: number | undefined, { owner, agent }: { owner: string; agent: string }): string {
  const ask = one.proposals.length > 0 ? '' : `; ${agent} proposes it with: process-rules propose ${one.number}`;
  return one.kind === 'added'
    ? `#${slice} was added to work item #${parent} after its approval; ${owner} reacts 👍 on ${agent}'s proposal on #${slice}, or adds a "Decision:" comment naming #${slice}${ask}`
    : `state #${one.number} was closed as not planned after approval; ${owner} reacts 👍 on ${agent}'s proposal for it on #${slice}, or adds a "Decision:" comment to it${ask}`;
}

/**
 * The work rules for building one slice, as problems; none means it may be
 * built: the slice is a Slice under a Work item the owner approved; a slice
 * added after the approval, and an approved State closed as not planned, each
 * carry the owner's say, a `Decision:` comment or a 👍 on the agent's
 * proposal; and no other open pull request builds the slice.
 */
export async function sliceProblems(
  sys: Sys,
  token: string,
  slug: string,
  slice: number,
  accounts: { owner: string; agent: string },
  mine: { pull?: number; branch?: string },
): Promise<string[]> {
  const read = await readSlice(sys, token, slug, slice, accounts);
  if (read.problems.length > 0) return read.problems;
  const problems = read.owed.filter((one) => !one.settled).map((one) => owedProblem(one, slice, read.parent, accounts));

  // The pull request being checked: by number, or by its branch in this repository (not a fork's of the same name).
  for (let page = 1; ; page++) {
    const pulls = await sys.http(`${API}/repos/${slug}/pulls?state=open&per_page=100&page=${page}`, { token });
    if (pulls.status !== 200 || !Array.isArray(pulls.json)) throw new Error(`cannot list open pull requests (HTTP ${pulls.status})`);
    for (const pull of pulls.json as { number: number; body: string | null; head: { ref: string; repo: { full_name: string } | null } }[]) {
      if (pull.number === mine.pull || (pull.head.ref === mine.branch && pull.head.repo?.full_name.toLowerCase() === slug.toLowerCase())) continue;
      if (slicesNamed(pull.body ?? '').includes(slice)) problems.push(`#${slice} already has pull request #${pull.number}; one slice, one pull request`);
    }
    if (pulls.json.length < 100) break;
  }
  return problems;
}

function report(io: Output, where: string, problems: string[]): number {
  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length > 0) {
    io.err(`${where}: refused by the work rules`);
    return 1;
  }
  return 0;
}

/**
 * The work rules on a pull request, run by the shared workflow. The owner's
 * pull requests pass; an agent's must name exactly one slice, as a line
 * `Slice: #N`, that may be built.
 */
export async function prWorkRules(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-work-rules runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    pull_request?: { number: number; body: string | null; user: { login: string }; head: { ref: string } };
  };
  const pull = event.pull_request;
  if (!pull) {
    io.out('pr-work-rules: not a pull request; nothing to check');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-work-rules');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  const { owner, agent } = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'work-rules')) {
    io.out(offLine('pr-work-rules', 'work-rules'));
    return 0;
  }
  if (!sameLogin(pull.user.login, agent)) {
    io.out(`pr-work-rules: #${pull.number} is by ${pull.user.login}, not the agent; the work rules bind agent pull requests`);
    return 0;
  }
  const slices = slicesNamed(pull.body ?? '');
  if (slices.length !== 1) {
    return report(io, 'pr-work-rules', [
      slices.length === 0
        ? `#${pull.number} names no slice; add a line "Slice: #N" to its description`
        : `#${pull.number} names ${slices.length} slices (${slices.map((n) => `#${n}`).join(', ')}); an agent pull request builds exactly one`,
    ]);
  }
  const [slice] = slices as [number];
  const problems = await sliceProblems(sys, token, slug, slice, { owner, agent }, { pull: pull.number });
  if (problems.length === 0) io.out(`✓ pr-work-rules: #${pull.number} builds slice #${slice}, which may be built`);
  return report(io, 'pr-work-rules', problems);
}

const ZERO = /^0+$/;

/** The token an agent session reaches GitHub with: in a Claude cloud session, through its proxy. */
export function sessionToken(sys: Sys): string | undefined {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') return cloudToken(sys);
  const token = sys.env.GH_TOKEN;
  return token && token !== NO_TOKEN ? token : undefined;
}

function gitLog(sys: Sys, root: string, args: string[]): string {
  const log = sys.exec('git', ['log', ...args], { cwd: root });
  if (log.code !== 0) throw new Error(`git log failed: ${log.stderr.trim()}`);
  return log.stdout;
}

/**
 * When every commit in `range` is a merge, the messages of the commits its
 * tip reaches that the merges did not bring in: the branch's own, a merge's
 * first parent being the branch it was made on. Otherwise undefined.
 */
function branchBeyondMerges(sys: Sys, root: string, range: string[]): string | undefined {
  const parents = gitLog(sys, root, ['--format=%P', ...range]).split('\n').filter(Boolean).map((line) => line.split(' '));
  if (parents.some((commit) => commit.length < 2)) return undefined;
  return gitLog(sys, root, ['--no-merges', '--format=%B', range[0] as string, '--not', ...parents.flatMap((commit) => commit.slice(1))]);
}

/**
 * Before a push from an agent session, run by the client's pre-push git hook
 * with git's ref lines on stdin and the remote's URL: first that it reaches
 * GitHub as the agent, the pre-push identity guard, which holds even in a
 * session whose Claude Code hooks never ran. Then the work rules: all the commits one push
 * brings, across every ref, must name exactly one slice between them, as a
 * trailer `Slice: #N`, that may be built. Commits a remote already has, such
 * as the default branch's, are not the push's own; a push whose own commits
 * are all merges, such as a merge of the default branch, is judged by the
 * branch's commits that the merges did not bring. Pushes outside agent
 * sessions pass; an agent session with no token is refused.
 */
export async function prePush(sys: Sys, io: Output, refLines: string, url: string): Promise<number> {
  if (!agentSession(sys)) return 0;
  const { root, slug } = repoAt(sys);
  const { owner, agent } = loadSettings(sys, root);
  const identity = await pushIdentityProblem(sys, root, url, agent);
  if (identity) {
    io.err(`✗ ${identity}`);
    io.err(`pre-push: refused; an agent session pushes to GitHub only as ${agent}`);
    return 1;
  }
  if (!isOn(sys, root, 'work-rules')) {
    io.err(offLine('pre-push', 'work-rules'));
    return 0;
  }
  const token = sessionToken(sys);
  if (!token) {
    return report(io, 'pre-push', ['this agent session has no token, so the work rules cannot be checked; run process-rules doctor']);
  }
  let messages = '';
  const branches: string[] = [];
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, local, remoteRef, remote] = line.split(' ');
    if (!local || !remoteRef || ZERO.test(local)) continue;
    const range = [local, '--not', ...(remote && !ZERO.test(remote) ? [remote] : []), '--remotes'];
    let log = gitLog(sys, root, ['--format=%B', ...range]);
    if (!log.trim()) continue;
    if (slicesNamed(log).length === 0) log = branchBeyondMerges(sys, root, range) ?? log;
    messages += `${log}\n`;
    branches.push(remoteRef.replace(/^refs\/heads\//, ''));
  }
  if (branches.length === 0) return 0;
  const slices = slicesNamed(messages);
  const where = branches.join(', ');
  if (slices.length !== 1) {
    return report(io, 'pre-push', [
      slices.length === 0
        ? `the commits for ${where} name no slice; add a trailer "Slice: #N" to a commit message`
        : `the commits for ${where} name ${slices.length} slices (${slices.map((n) => `#${n}`).join(', ')}); one push builds one slice`,
    ]);
  }
  if (branches.length > 1) return report(io, 'pre-push', [`one push builds one slice on one branch; this one pushes ${where}`]);
  const [slice] = slices as [number];
  return report(io, 'pre-push', await sliceProblems(sys, token, slug, slice, { owner, agent }, { branch: branches[0] as string }));
}

/** The label that puts an issue in the owner's Needs you view. */
const NEEDS_OWNER = 'needs-owner';

function proposalBody(one: Owed, parent: number | undefined, owner: string): string {
  // The issue it is for comes first: that is how the work rules match a 👍 to it.
  const what = one.kind === 'added'
    ? `add #${one.number} (${one.title}) to work item #${parent}, after its approval.`
    : `drop state #${one.number} (${one.title}), closed as not planned after work item #${parent}'s approval.`;
  return `Proposal: ${what}\n\n@${owner}: react 👍 to this comment to approve it, or comment "Decision:".`;
}

/**
 * Proposes what slice `number` owes the owner, run by an agent session: one
 * `Proposal:` comment on the slice, as the agent, for its addition after the
 * work item's approval and one for each state dropped after it, labeling
 * the slice `needs-owner`. Given a State, proposes that state alone. Run
 * again, it posts nothing twice, and once the owner has settled everything
 * it takes the label off.
 */
export async function propose(sys: Sys, io: Output, number: number): Promise<number> {
  const { root, slug } = repoAt(sys);
  const accounts = loadSettings(sys, root);
  if (!isOn(sys, root, 'work-rules')) {
    io.out(offLine('propose', 'work-rules'));
    return 0;
  }
  const token = sessionToken(sys);
  if (!token) return report(io, 'propose', ['this session has no token; run process-rules doctor']);
  // Only the agent's proposals count, so one posted as anyone else would wait for nothing.
  const user = await sys.http(`${API}/user`, { token });
  const login = (user.json as { login?: string } | null)?.login;
  if (user.status !== 200 || !sameLogin(login, accounts.agent)) {
    return report(io, 'propose', [`propose posts as ${accounts.agent}, but this session's token is ${login ?? 'refused'}`]);
  }

  const issue = await readIssue(sys, token, slug, number);
  const parent = issue?.type?.name === 'State' ? await parentOf(sys, token, number, issue) : undefined;
  const state = parent?.type?.name === 'Slice';
  const slice = state ? parent.number : number;
  const read = await readSlice(sys, token, slug, slice, accounts);
  if (read.problems.length > 0) return report(io, 'propose', read.problems);
  const asked = read.owed.filter((one) => !state || one.number === number);
  if (asked.length === 0) {
    io.out(`propose: #${number} needs no decision from ${accounts.owner}`);
    return 0;
  }

  const issues = `${API}/repos/${slug}/issues/${slice}`;
  for (const one of asked) {
    const what = one.kind === 'added' ? `#${slice}` : `state #${one.number}`;
    if (one.settled) {
      io.out(`✓ ${what}: ${accounts.owner} has decided`);
    } else if (one.proposals.length > 0) {
      io.out(`${what}: proposed on #${slice}, waiting on ${accounts.owner}'s 👍`);
    } else {
      const posted = await sys.http(`${issues}/comments`, { method: 'POST', token, body: { body: proposalBody(one, read.parent, accounts.owner) } });
      if (posted.status !== 201) throw new Error(`cannot comment on #${slice} (HTTP ${posted.status})`);
      io.out(`✓ ${what}: proposed on #${slice}: ${(posted.json as { html_url?: string } | null)?.html_url ?? ''}`.trimEnd());
    }
  }
  if (read.owed.some((one) => !one.settled)) {
    const labeled = await sys.http(`${issues}/labels`, { method: 'POST', token, body: { labels: [NEEDS_OWNER] } });
    if (labeled.status !== 200) throw new Error(`cannot label #${slice} ${NEEDS_OWNER} (HTTP ${labeled.status})`);
    io.out(`#${slice} is labeled ${NEEDS_OWNER}, so it shows in ${accounts.owner}'s Needs you view`);
    return 0;
  }
  const removed = await sys.http(`${issues}/labels/${NEEDS_OWNER}`, { method: 'DELETE', token });
  // 404: the slice had no such label.
  if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot take ${NEEDS_OWNER} off #${slice} (HTTP ${removed.status})`);
  io.out(`✓ #${slice}: nothing waits on ${accounts.owner}`);
  return 0;
}
