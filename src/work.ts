import { API, NO_TOKEN, type Settings, anyLogin, either, loadSettings, repoAt } from './agent.ts';
import { PERSONAL_REPO, isOn, isPersonal, notAdoptedLine, offLine, readRepo } from './features.ts';
import { agentSession, pushIdentityProblem } from './push-identity.ts';
import { cloudToken } from './cloud.ts';
import { ONBOARD_BRANCH, ONBOARD_FILES } from './onboard-pull.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_HOST_RE, GITHUB_WEB } from './host.ts';
import { boardStarted } from './board.ts';
import { ownersAlone, whyNotCounted } from './edits.ts';
import { batchAnswers } from './approvals.ts';

/** How a pull request or a commit names the slice it builds. */
const SLICE_LINE = new RegExp(`^Slice:\\s*(?:#|https://${GITHUB_HOST_RE}/[^/\\s]+/[^/\\s]+/issues/)(\\d+)\\s*$`, 'gim');

/** How a pull request names a State of its slice that it delivers. */
const STATE_LINE = new RegExp(`^State:\\s*(?:#|https://${GITHUB_HOST_RE}/[^/\\s]+/[^/\\s]+/issues/)(\\d+)\\s*$`, 'gim');

/** The issues `line` names in `text`, in order, without repeats. */
const named = (line: RegExp, text: string): number[] => [...new Set([...text.matchAll(line)].map((match) => Number(match[1])))];

/** The slices `text` names, in order, without repeats. */
export function slicesNamed(text: string): number[] {
  return named(SLICE_LINE, text);
}

/** The States `text` names with a line `State: #N`, in order, without repeats. */
export function statesNamed(text: string): number[] {
  return named(STATE_LINE, text);
}

interface Comment {
  id: number | string;
  /** Its GraphQL id, from which its edits are read. */
  node_id?: string;
  user: { login: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
  /** Its own address on GitHub, `…/issues/N#issuecomment-ID`: where the owner acts on it. */
  html_url: string;
}

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  /** The issue's address in GitHub's REST API, from which its comments, sub-issues and timeline are read. */
  url: string;
  type: { name: string } | null;
  state?: string;
  state_reason: string | null;
  closed_at: string | null;
  pull_request?: unknown;
}

type TimelineEvent =
  | { event: 'labeled' | 'unlabeled'; created_at: string; actor: { login: string } | null; label: { name: string } }
  | { event: 'sub_issue_added'; created_at: string; sub_issue: { number: number } | null }
  | { event: 'parent_issue_added'; created_at: string }
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

/** The owners' `Decision:` comments among `comments`, after `since` when given, mentioning `mention` when given. */
function decisionsIn(comments: Comment[], owners: string[], since?: string, mention?: string): Comment[] {
  return comments.filter(
    (comment) =>
      anyLogin(owners, comment.user?.login) &&
      /^\s*Decision:/i.test(comment.body) &&
      (!since || comment.created_at > since) &&
      (!mention || new RegExp(`${mention}\\b`).test(comment.body)),
  );
}

/**
 * Whether one of the owners' `decisions` counts: one no one edited does at
 * once, without GraphQL; an edited one only if owners made every edit. When
 * none counts and an edit is why, `note` says so.
 */
async function decided(sys: Sys, token: string, decisions: Comment[], owners: string[]): Promise<{ settled: boolean; note?: string }> {
  if (decisions.some((decision) => !editedAt(decision))) return { settled: true };
  const counted = await ownersAlone(sys, token, decisions, owners);
  const note = whyNotCounted(counted, '"Decision:" comment');
  return { settled: counted.kept.length > 0, ...(note ? { note } : {}) };
}

/** A proposal's first line, and the issue it names first: what the proposal is for. */
const PROPOSAL = /^\s*Proposal:[^#\n]*#(\d+)\b/i;

/** The agents' proposals among `comments` for issue `number`. */
function proposalsFor(comments: Comment[], agents: string[], number: number): Comment[] {
  return comments.filter((comment) => anyLogin(agents, comment.user?.login) && Number(PROPOSAL.exec(comment.body)?.[1]) === number);
}

/** A decision the owner owes a slice: its addition after the work item's approval, or a state dropped after it. */
interface Owed {
  kind: 'added' | 'dropped';
  /** The slice, when it was added; the state, when it was dropped. */
  number: number;
  title: string;
  /** The body of the slice, or of the state: what a proposal says for it. */
  body: string;
  /** The owner's say counts only after this, when given: the slice's latest addition. */
  since?: string;
  /** The agent's proposals for it, on the slice. */
  proposals: Comment[];
  /**
   * Whether the owner gave it: a `Decision:` comment, a request on the work
   * item the slice links, a batch answer on the Approvals issue naming it on
   * its first line, or 👍 on one of the proposals.
   */
  settled: boolean;
  /** Why an owner's edited `Decision:` comment did not settle it, when one was there. */
  note?: string;
}

/**
 * Whether an owner reacted 👍 to one of `proposals`, after `since` when
 * given and after the proposal's last edit, from the reactions read by id.
 */
function thumbsUp(proposals: Comment[], reactions: Map<Comment['id'], Reaction[]>, owners: string[], since?: string): boolean {
  return proposals.some((proposal) =>
    (reactions.get(proposal.id) ?? []).some((reaction) => {
      const edited = editedAt(proposal);
      return anyLogin(owners, reaction.user?.login) && (!since || reaction.created_at > since) && (!edited || reaction.created_at > edited);
    }),
  );
}

/**
 * Whether the slice's `body` links a comment an owner wrote on work item
 * `parent` before `since`, the slice's latest addition: a request on GitHub
 * is its own approval. GitHub, not the link, says who wrote the comment, on
 * which issue and when; one edited since it was written does not count,
 * since REST does not say who edited it.
 */
function requested(body: string, slug: string, parent: number, comments: Comment[], owners: string[], since: string): boolean {
  const link = new RegExp(`https://${GITHUB_HOST_RE}/${slug.replaceAll('.', '\\.')}/issues/${parent}#issuecomment-(\\d+)\\b`, 'gi');
  const linked = new Set([...body.matchAll(link)].map((match) => match[1]));
  return comments.some(
    (comment) => linked.has(String(comment.id)) && anyLogin(owners, comment.user?.login) && comment.created_at < since && !editedAt(comment),
  );
}

/** Issue `number` of `slug`, or undefined when there is none (a pull request is not one). */
async function readIssue(sys: Sys, token: string, slug: string, number: number): Promise<Issue | undefined> {
  const issue = (await rest(sys, token, number, `${API}/repos/${slug}/issues/${number}`, true)) as Issue | undefined;
  return issue && !issue.pull_request ? issue : undefined;
}

/**
 * The issue `issue` is a sub-issue of, none, or why it could not be read.
 * Read from the parent endpoint, not the issue's `parent_issue_url`: on a
 * private repository a workflow's GITHUB_TOKEN gets that field back as null.
 */
async function parentOf(sys: Sys, token: string, issue: Issue): Promise<{ parent?: Issue; problem?: string }> {
  const { status, json } = await sys.http(`${issue.url}/parent`, { token });
  if (status === 200) return { parent: json as Issue };
  const message = (json as { message?: string } | null)?.message;
  // An issue with no parent reads as 404 "No parent issue found"; any other failure is a read that failed, not a missing parent.
  if (status === 404 && message && /no parent/i.test(message)) return {};
  return { problem: `could not read #${issue.number}'s parent (HTTP ${status}${message ? `: ${message}` : ''})` };
}

/**
 * Reads slice `slice` against the work rules' approvals: the problems that
 * stop it outright (not a Slice under a Work item an owner approved), else
 * the decisions it owes an owner and whether each was given.
 */
async function readSlice(
  sys: Sys,
  token: string,
  slug: string,
  slice: number,
  { owners, agents, approvals }: Settings,
): Promise<{ problems: string[]; parent?: number; owed: Owed[]; closed?: boolean; states?: Issue[] }> {
  const issue = await readIssue(sys, token, slug, slice);
  if (!issue) return { problems: [`#${slice} is not an issue in ${slug}`], owed: [] };
  if (issue.type?.name !== 'Slice') return { problems: [`#${slice} is not a Slice (its type is ${issue.type?.name ?? 'none'})`], owed: [] };
  const { parent, problem } = await parentOf(sys, token, issue);
  if (problem) return { problems: [problem], owed: [] };
  if (parent?.type?.name !== 'Work item') return { problems: [`#${slice} is not a sub-issue of a Work item`], owed: [] };

  const events = await every<TimelineEvent>(sys, token, slice, `${parent.url}/timeline`);
  const approval = events
    .filter((event): event is Extract<TimelineEvent, { event: 'labeled' | 'unlabeled' }> => (event.event === 'labeled' || event.event === 'unlabeled') && event.label.name === 'approved')
    .at(-1);
  if (approval?.event !== 'labeled') {
    return { problems: [`work item #${parent.number} is not approved: ${either(owners)} adds the approved label before any slice starts`], owed: [] };
  }
  if (!anyLogin(owners, approval.actor?.login)) {
    return { problems: [`work item #${parent.number} was labeled approved by ${approval.actor?.login ?? 'someone unknown'}, not ${either(owners)}`], owed: [] };
  }
  const approvedAt = approval.created_at;
  const parentComments = events.filter((event): event is { event: 'commented' } & Comment => event.event === 'commented');
  // Every comment on the slice, so a proposal or decision that later discussion pushed back still counts.
  const comments = await every<Comment>(sys, token, slice, `${issue.url}/comments`);
  // Every state, however many: one past the first page can be a dropped one.
  const states = await every<Issue>(sys, token, slice, `${issue.url}/sub_issues`);
  // The Approvals issue's comments, read once a check and only when a decision owed may need them; an
  // Approvals issue GitHub cannot find answers nothing. Only an owner's comment whose first line approves
  // `number`, made after `since`, counts there.
  let batch: Comment[] | undefined;
  const batchFor = async (number: number, since: string): Promise<Comment[]> => {
    if (approvals === undefined) return [];
    batch ??= await every<Comment>(sys, token, slice, `${API}/repos/${slug}/issues/${approvals}/comments`, true);
    return batchAnswers(batch, owners, number, since);
  };

  const owed: Owed[] = [];
  // When the slice was last added to its work item. A workflow's GITHUB_TOKEN on a private repository reads the
  // work item's sub_issue_added events with `sub_issue` null, so the slice's own parent_issue_added events say it.
  const joined = async (number: number, url: string): Promise<string[]> =>
    (await every<TimelineEvent>(sys, token, number, `${url}/timeline`))
      .filter((event) => event.event === 'parent_issue_added')
      .map((event) => (event as { created_at: string }).created_at);
  const mine = [
    ...(await joined(slice, issue.url)),
    ...events.flatMap((event) => (event.event === 'sub_issue_added' && event.sub_issue?.number === slice ? [event.created_at] : [])),
  ];
  // An addition after approval that names no issue may be this slice's. It is put down to another sub-issue of the
  // work item only when that one's own timeline records an addition at the same moment; any other counts as this
  // slice's, so it owes the owner's say rather than passing.
  let hidden = events.flatMap((event) =>
    event.event === 'sub_issue_added' && !event.sub_issue && event.created_at > approvedAt && !mine.includes(event.created_at) ? [event.created_at] : [],
  );
  if (hidden.length > 0) {
    for (const sibling of await every<Issue>(sys, token, slice, `${parent.url}/sub_issues`)) {
      if (sibling.number === slice || hidden.length === 0) continue;
      const theirs = await joined(slice, sibling.url);
      hidden = hidden.filter((at) => !theirs.includes(at));
    }
  }
  const added = [...mine, ...hidden].sort().at(-1);
  if (added && added > approvedAt) {
    const local = [...decisionsIn(parentComments, owners, added, `#${slice}`), ...decisionsIn(comments, owners, added)];
    // The Approvals issue is read only when no request and no unedited decision here settles it.
    const decision = requested(issue.body ?? '', slug, parent.number, parentComments, owners, added)
      ? { settled: true }
      : await decided(sys, token, local.some((one) => !editedAt(one)) ? local : [...local, ...(await batchFor(slice, added))], owners);
    owed.push({
      kind: 'added',
      number: slice,
      title: issue.title,
      body: issue.body ?? '',
      since: added,
      proposals: proposalsFor(comments, agents, slice),
      ...decision,
    });
  }
  for (const state of states) {
    if (state.type?.name !== 'State' || state.state_reason !== 'not_planned' || !state.closed_at || state.closed_at < approvedAt) continue;
    const onSlice = decisionsIn(comments, owners, undefined, `#${state.number}`);
    // The state's own comments, and the Approvals issue's after the state was dropped, are read only when no
    // unedited decision on the slice settles it.
    const decisions = onSlice.some((one) => !editedAt(one))
      ? onSlice
      : [...onSlice, ...decisionsIn(await every<Comment>(sys, token, slice, `${state.url}/comments`), owners), ...(await batchFor(state.number, state.closed_at))];
    owed.push({
      kind: 'dropped',
      number: state.number,
      title: state.title,
      body: state.body ?? '',
      proposals: proposalsFor(comments, agents, state.number),
      ...(await decided(sys, token, decisions, owners)),
    });
  }

  // Reactions are read only for the proposals that could still settle something; a deleted proposal has none.
  const reactions = new Map<Comment['id'], Reaction[]>();
  for (const proposal of owed.filter((one) => !one.settled).flatMap((one) => one.proposals)) {
    reactions.set(proposal.id, await every<Reaction>(sys, token, slice, `${API}/repos/${slug}/issues/comments/${proposal.id}/reactions?content=%2B1`, true));
  }
  for (const one of owed) one.settled ||= thumbsUp(one.proposals, reactions, owners, one.since);
  return { problems: [], parent: parent.number, owed, closed: issue.state === 'closed', states };
}

/**
 * What is wrong with the States a pull request for slice `slice` names with
 * `State: #N` lines, so the merged job can close them: each must be a State
 * under the slice, and a pull request for a slice closed already, a fix,
 * must name the open State it is filed as.
 */
function stateProblems(slice: number, closed: boolean, states: Issue[], names: number[]): string[] {
  const problems = names.flatMap((number) =>
    states.some((state) => state.number === number && state.type?.name === 'State')
      ? []
      : [`#${number} is not a State under slice #${slice}; a "State: #N" line names a State sub-issue of the slice the pull request builds`],
  );
  const open = states.some((state) => names.includes(state.number) && state.type?.name === 'State' && state.state !== 'closed');
  if (closed && !open) {
    problems.push(`#${slice} is closed, so this pull request is a fix: file it as a State under #${slice} and name it with a line "State: #N"`);
  }
  return problems;
}

/** Why `owed` stops slice `slice`, and how the owner settles it. */
function owedProblem(one: Owed, slice: number, parent: number | undefined, { owners, agents, approvals }: Settings): string {
  const owner = either(owners);
  // The agent proposes as itself; with several, any of them.
  const agent = either(agents);
  const ask = `${one.note ? ` (${one.note})` : ''}${one.proposals.length > 0 ? '' : `; ${agent} proposes it with: process-rules propose ${one.number}`}`;
  // Where the settings name an Approvals issue, one comment there answers this among a batch.
  const batch = approvals === undefined ? '' : `, or ${owner} comments on #${approvals}, the Approvals issue, with a first line "Decision: approve #${one.number}"`;
  return one.kind === 'added'
    ? `#${slice} was added to work item #${parent} after its approval; ${owner} reacts 👍 on ${agent}'s proposal on #${slice}, or adds a "Decision:" comment naming #${slice}, or #${slice} links ${owner}'s request for it on #${parent}${batch}${ask}`
    : `state #${one.number} was closed as not planned after approval; ${owner} reacts 👍 on ${agent}'s proposal for it on #${slice}, or adds a "Decision:" comment to it${batch}${ask}`;
}

/**
 * The work rules for building one slice, as problems; none means it may be
 * built: the slice is a Slice under a Work item the owner approved; a slice
 * added after the approval, and an approved State closed as not planned, each
 * carry the owner's say, a `Decision:` comment or a 👍 on the agent's
 * proposal; no other open pull request builds the slice; and, for a pull
 * request, whose States are in `mine.states`, each is a State under the slice
 * and a closed slice's names an open one.
 */
export async function sliceProblems(
  sys: Sys,
  token: string,
  slug: string,
  slice: number,
  accounts: Settings,
  mine: { pull?: number; branch?: string; states?: number[] },
): Promise<string[]> {
  const read = await readSlice(sys, token, slug, slice, accounts);
  if (read.problems.length > 0) return read.problems;
  const problems = read.owed.filter((one) => !one.settled).map((one) => owedProblem(one, slice, read.parent, accounts));
  if (mine.states) problems.push(...stateProblems(slice, read.closed ?? false, read.states ?? [], mine.states));

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
 * `Slice: #N`, that may be built, and name with lines `State: #N` only States
 * under it, at least one open one when the slice is closed already (a fix);
 * but for onboard's own: from ONBOARD_BRANCH
 * in this repository, changing only the files onboard writes and deleting
 * none, which the owner confirmed at the terminal and merges.
 */
export async function prWorkRules(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-work-rules runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    pull_request?: { number: number; body: string | null; user: { login: string }; head: { ref: string; repo?: { full_name: string } | null } };
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
  const accounts = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'work-rules')) {
    io.out(offLine('pr-work-rules', 'work-rules'));
    return 0;
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('pr-work-rules', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  if (!anyLogin(accounts.agents, pull.user.login)) {
    io.out(`pr-work-rules: #${pull.number} is by ${pull.user.login}, not an agent; the work rules bind agent pull requests`);
    return 0;
  }
  if (pull.head.ref === ONBOARD_BRANCH && pull.head.repo?.full_name.toLowerCase() === slug.toLowerCase()) {
    const files = await every<{ filename: string; status?: string; previous_filename?: string }>(sys, token, pull.number, `${API}/repos/${slug}/pulls/${pull.number}/files`);
    const names = files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
    // onboard writes its files and never deletes one: a deleted workflow or settings file would switch the checks off.
    if (names.every((name) => ONBOARD_FILES.includes(name)) && !files.some((file) => file.status === 'removed')) {
      io.out(`✓ pr-work-rules: #${pull.number} is onboard's, changing only the files onboard writes, so it names no slice`);
      return 0;
    }
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
  const problems = await sliceProblems(sys, token, slug, slice, accounts, { pull: pull.number, states: statesNamed(pull.body ?? '') });
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

/** A full commit id, as GitHub's API and `git rev-parse` give one. */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The remote's default branch, as GitHub names it, and the commits in this
 * clone where it is, every commit they reach being the default branch's, not
 * a push's own: its tip as GitHub names it, when the clone has that commit,
 * and its remote-tracking ref on origin, when there is one. Either may be
 * missing or behind in a clone, such as a single-branch clone that fetched
 * the default branch into FETCH_HEAD alone. No branch when GitHub names none.
 */
async function defaultBranch(sys: Sys, root: string, slug: string, token: string): Promise<{ branch?: string; tips: string[] }> {
  const branch = ((await readRepo(sys, slug, token)).json as { default_branch?: unknown } | null)?.default_branch;
  if (typeof branch !== 'string' || !branch) return { tips: [] };
  const ref = await sys.http(`${API}/repos/${slug}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { token });
  const sha = ref.status === 200 ? (ref.json as { object?: { sha?: unknown } } | null)?.object?.sha : undefined;
  const tips: string[] = [];
  for (const where of [...(typeof sha === 'string' && COMMIT_ID.test(sha) ? [sha] : []), `refs/remotes/origin/${branch}`]) {
    const found = sys.exec('git', ['rev-parse', '--verify', '--quiet', `${where}^{commit}`], { cwd: root });
    const commit = found.stdout.trim();
    if (found.code === 0 && COMMIT_ID.test(commit) && !tips.includes(commit)) tips.push(commit);
  }
  return { branch, tips };
}

/**
 * The commits that merges in `range` brought in, other than through their
 * first parent, that GitHub says are on its default branch `branch`: a merge
 * of the default branch fetched after the clone's tips for it, so that they
 * do not reach what it brought.
 */
async function mergedFromDefault(sys: Sys, root: string, slug: string, token: string, branch: string, range: string[]): Promise<string[]> {
  const merges = gitLog(sys, root, ['--merges', '--format=%P', ...range]).split('\n').filter(Boolean);
  const brought = new Set(merges.flatMap((line) => line.split(' ').slice(1)).filter((commit) => COMMIT_ID.test(commit)));
  const found: string[] = [];
  for (const parent of brought) {
    const compared = await sys.http(`${API}/repos/${slug}/compare/${branch.split('/').map(encodeURIComponent).join('/')}...${parent}?per_page=1`, { token });
    const status = compared.status === 200 ? (compared.json as { status?: unknown } | null)?.status : undefined;
    if (status === 'behind' || status === 'identical') found.push(parent);
  }
  return found;
}

/**
 * Before a push from an agent session, run by the client's pre-push git hook
 * with git's ref lines on stdin and the remote's URL: first that it reaches
 * GitHub as the agent, the pre-push identity guard, which holds even in a
 * session whose Claude Code hooks never ran. Then the work rules: all the commits one push
 * brings, across every ref, must name exactly one slice between them, as a
 * trailer `Slice: #N`, that may be built. Commits a remote already has, and
 * the commits on the remote's default branch that the clone can find, are not
 * the push's own, so a merge of the default branch brings none of its slices;
 * where the clone's tips for the default branch are behind, GitHub is asked
 * which of the commits the push's merges brought are on it. A push whose own
 * commits name no slice, such as a merge or a commit with no trailer, is
 * judged by the branch's own commits: those the default branch does not
 * reach or, where the clone cannot tell where the default branch is and the
 * push's commits are all merges, those the merges did not bring. Pushes
 * outside agent sessions pass; an agent session with no token is refused.
 */
export async function prePush(sys: Sys, io: Output, refLines: string, url: string): Promise<number> {
  if (!agentSession(sys)) return 0;
  const { root, slug } = repoAt(sys);
  const accounts = loadSettings(sys, root);
  const identity = await pushIdentityProblem(sys, root, url, accounts.agents);
  if (identity) {
    io.err(`✗ ${identity}`);
    io.err(`pre-push: refused; an agent session pushes to GitHub only as ${either(accounts.agents)}`);
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
  if (await isPersonal(sys, slug, token)) {
    io.err(offLine('pre-push', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const { branch, tips } = await defaultBranch(sys, root, slug, token);
  let messages = '';
  const branches: string[] = [];
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, local, remoteRef, remote] = line.split(' ');
    if (!local || !remoteRef || ZERO.test(local)) continue;
    let base = tips;
    const rangeOf = (not: string[]): string[] => [local, '--not', ...(remote && !ZERO.test(remote) ? [remote] : []), '--remotes', ...not];
    let log = gitLog(sys, root, ['--format=%B', ...rangeOf(base)]);
    if (!log.trim()) continue;
    // Asked of GitHub only when the push would be refused: what its merges brought from the default branch.
    if (branch && slicesNamed(log).length !== 1) {
      const merged = await mergedFromDefault(sys, root, slug, token, branch, rangeOf(base));
      if (merged.length > 0) {
        base = [...base, ...merged];
        log = gitLog(sys, root, ['--format=%B', ...rangeOf(base)]);
      }
    }
    if (slicesNamed(log).length === 0) {
      log = (base.length > 0 ? gitLog(sys, root, ['--format=%B', local, '--not', ...base]) : branchBeyondMerges(sys, root, rangeOf(base))) ?? log;
    }
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
  const problems = await sliceProblems(sys, token, slug, slice, accounts, { branch: branches[0] as string });
  if (problems.length === 0 && isOn(sys, root, 'board')) await moveBoard(sys, io, token, slug, slice);
  return report(io, 'pre-push', problems);
}

/**
 * Moves the board on for slice `slice`, which a push is starting to build,
 * with the board feature on, through GitHub's REST API, which a Claude
 * cloud session's proxy lets through; a board it cannot read, or a move
 * GitHub refuses, is said and does not stop the push.
 */
async function moveBoard(sys: Sys, io: Output, token: string, slug: string, slice: number): Promise<void> {
  try {
    for (const line of await boardStarted(sys, token, slug, slice)) io.err(line);
  } catch (error) {
    io.err(`! board: could not read where #${slice} and its work item are on the board, so nothing moved (${(error as Error).message}); the push goes on`);
  }
}

/** Throws for a write to an issue that GitHub refused, saying how to fix a workflow that grants no issues: write. */
function refused(result: { status: number; json: unknown }, what: string): never {
  const why = (result.json as { message?: string } | null)?.message ?? `HTTP ${result.status}`;
  // A client workflow from before this release grants this job no issues: write.
  const hint = /not accessible/i.test(why) ? '; the client workflow needs a job with issues: write for merged pull requests, so run process-rules onboard to update it' : '';
  throw new Error(`cannot ${what}: ${why}${hint}`);
}

/**
 * Comments on `issue` that pull request `pull` built it, unless it says so
 * already, and closes it as completed unless it is closed: a slice or State
 * GitHub closed already, through a closing keyword beside its line, still
 * gets the comment.
 */
async function closeBuilt(sys: Sys, io: Output, token: string, issue: Issue, pull: { number: number; base: { ref: string } }): Promise<void> {
  const built = new RegExp(`\\bBuilt in #${pull.number}\\b`);
  const comments = await every<Comment>(sys, token, issue.number, `${issue.url}/comments`);
  const commented = comments.some((one) => built.test(one.body ?? ''));
  if (!commented) {
    const posted = await sys.http(`${issue.url}/comments`, { method: 'POST', token, body: { body: `Built in #${pull.number}, merged into ${pull.base.ref}.` } });
    if (posted.status !== 201) refused(posted, `${issue.state === 'closed' ? 'comment on' : 'close'} #${issue.number}`);
  }
  if (issue.state === 'closed') {
    io.out(
      commented
        ? `✓ #${issue.number} is closed already and says it was built in #${pull.number}`
        : `✓ #${issue.number} is closed already; commented that it was built in #${pull.number}`,
    );
    return;
  }
  const closed = await sys.http(issue.url, { method: 'PATCH', token, body: { state: 'closed', state_reason: 'completed' } });
  if (closed.status !== 200) refused(closed, `close #${issue.number}`);
  io.out(`✓ #${issue.number}: closed, built in #${pull.number}`);
}

/**
 * Closes the slices and States a merged pull request names, run by the
 * shared workflow when one merges into the default branch: each open Slice
 * it names with a line `Slice: #N`, and each open State under one of them it
 * names with a line `State: #N`, gets a comment linking the pull request and
 * is closed as completed, which the Project's Item closed workflow moves to
 * Done. Neither line is one of GitHub's closing keywords, so GitHub does not
 * close them. One that has the comment already gets no second one; a State
 * dropped as not planned, or under a slice the pull request does not name,
 * is left as it is.
 */
export async function prMerged(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-merged runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    pull_request?: { number: number; body: string | null; merged?: boolean; base: { ref: string } };
    repository?: { default_branch?: string };
  };
  const pull = event.pull_request;
  if (!pull?.merged) {
    io.out('pr-merged: not a merged pull request; nothing to close');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-merged');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  if (!isOn(sys, sys.cwd, 'work-rules')) {
    io.out(offLine('pr-merged', 'work-rules'));
    return 0;
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('pr-merged', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const branch = event.repository?.default_branch;
  if (branch && pull.base.ref !== branch) {
    io.out(`pr-merged: #${pull.number} merged into ${pull.base.ref}, not ${branch}; its slices stay open until their work reaches ${branch}`);
    return 0;
  }
  const slices = slicesNamed(pull.body ?? '');
  if (slices.length === 0) io.out(`pr-merged: #${pull.number} names no slice; nothing to close`);
  for (const slice of slices) {
    const issue = await readIssue(sys, token, slug, slice);
    if (issue?.type?.name !== 'Slice') {
      io.out(`- #${slice} is not a Slice in ${slug}; left as it is`);
      continue;
    }
    // GitHub closes a slice itself when the pull request also says "Closes #N"; the slice still gets its comment, once.
    await closeBuilt(sys, io, token, issue, pull);
  }
  for (const number of statesNamed(pull.body ?? '')) {
    const issue = await readIssue(sys, token, slug, number);
    if (issue?.type?.name !== 'State') {
      io.out(`- #${number} is not a State in ${slug}; left as it is`);
      continue;
    }
    const { parent, problem } = await parentOf(sys, token, issue);
    if (problem) throw new Error(`cannot close #${number}: ${problem}`);
    if (!parent || !slices.includes(parent.number)) {
      io.out(`- #${number} is not a State under a slice #${pull.number} names; left as it is`);
      continue;
    }
    if (issue.state_reason === 'not_planned') {
      io.out(`- #${number} was closed as not planned; left as it is`);
      continue;
    }
    await closeBuilt(sys, io, token, issue, pull);
  }
  return 0;
}

/** The newest of `comments`, which is not empty: GitHub lists comments oldest first. */
function newest(comments: Comment[]): Comment {
  return comments[comments.length - 1] as Comment;
}

/** The label that puts an issue in the owner's Needs you view. */
const NEEDS_OWNER = 'needs-owner';

/** The text of `body`'s section `**name:**`, up to the next line that starts a section, or undefined when it has none or it is empty. */
export function section(body: string, name: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const head = new RegExp(`^\\s*\\*\\*${name}:\\*\\*`, 'i');
  const from = lines.findIndex((line) => head.test(line));
  if (from < 0) return undefined;
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => /^\s*\*\*[^*\n]+:\*\*/.test(line));
  const text = [(lines[from] as string).replace(head, ''), ...(to < 0 ? rest : rest.slice(0, to))].join('\n').trim();
  return text || undefined;
}

/** The sections a proposal for `one` takes from its body, by the name the body gives each. */
const NEEDED = { added: ['You will see', 'Why'], dropped: ['Why'] } as const;

/** What `one`'s body lacks for a proposal that stands alone, as a problem, or undefined. */
function proposalGap(one: Owed): string | undefined {
  const missing = NEEDED[one.kind].filter((name) => !section(one.body, name));
  if (missing.length === 0) return undefined;
  const what = one.kind === 'added' ? `#${one.number}` : `state #${one.number}`;
  return `${what}'s body has no ${missing.map((name) => `"**${name}:**"`).join(' or ')} section; write it there first, so the proposal says what changes and why`;
}

/**
 * The `Proposal:` comment for `one`: what changes, why, what it costs and
 * what happens if the owner declines, so it stands alone.
 */
function proposalBody(one: Owed, slice: number, parent: number | undefined, { owners, approvals }: Settings): string {
  // The issue it is for comes first: that is how the work rules match a 👍 to it.
  const lines = one.kind === 'added'
    ? [
        `Proposal: add #${one.number} (${one.title}) to work item #${parent}, after its approval.`,
        `**What changes:** ${section(one.body, 'You will see')}`,
        `**Why:** ${section(one.body, 'Why')}`,
        `**What it costs:** ${section(one.body, 'Cost') ?? `one more slice of work item #${parent}: the agent builds it in a pull request, which you review.`}`,
        `**If you decline:** #${one.number} is closed as not planned and nothing of it is built; work item #${parent} keeps what you approved.`,
      ]
    : [
        `Proposal: drop state #${one.number} (${one.title}), closed as not planned after work item #${parent}'s approval.`,
        `**What changes:** slice #${slice} is built without state #${one.number}, which you approved.`,
        `**Why:** ${section(one.body, 'Why')}`,
        `**What it costs:** ${section(one.body, 'Cost') ?? `what state #${one.number} would show is not built.`}`,
        `**If you decline:** state #${one.number} is reopened and built as you approved it.`,
      ];
  // Where the settings name an Approvals issue, the owner may answer this there, among a batch.
  const batch = approvals === undefined ? '' : `, or answer the batch on Approvals, #${approvals}`;
  return `${lines.join('\n\n')}\n\n${either(owners.map((owner) => `@${owner}`))}: react 👍 to this comment to approve it, or comment "Decision:"${batch}.`;
}

/**
 * Proposes what each of `numbers` owes the owner, run by an agent session:
 * for a slice, one `Proposal:` comment on it, as the agent, for its addition
 * after the work item's approval and one for each state dropped after it,
 * labeling the slice `needs-owner`; for a State, that state alone. Run
 * again, it posts nothing twice, and once the owner has settled everything
 * it takes the label off. Where the settings name an Approvals issue, it
 * ends with the first line of the owner's batch answer there, naming every
 * proposal still waiting, ready to paste.
 */
export async function propose(sys: Sys, io: Output, numbers: readonly number[]): Promise<number> {
  const { root, slug } = repoAt(sys);
  const accounts = loadSettings(sys, root);
  if (!isOn(sys, root, 'work-rules')) {
    io.out(offLine('propose', 'work-rules'));
    return 0;
  }
  const token = sessionToken(sys);
  if (!token) return report(io, 'propose', ['this session has no token; run process-rules doctor']);
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('propose', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  // Only the agent's proposals count, so one posted as anyone else would wait for nothing.
  const user = await sys.http(`${API}/user`, { token });
  const login = (user.json as { login?: string } | null)?.login;
  if (user.status !== 200 || !anyLogin(accounts.agents, login)) {
    return report(io, 'propose', [`propose posts as ${either(accounts.agents)}, but this session's token is ${login ?? 'refused'}`]);
  }

  let code = 0;
  // Each issue once, in the order given, though two of the numbers share a slice.
  const waiting = new Set<number>();
  for (const number of numbers) {
    const one = await proposeOne(sys, io, token, slug, accounts, number);
    code = Math.max(code, one.code);
    for (const each of one.waiting) waiting.add(each);
  }
  if (accounts.approvals !== undefined && waiting.size > 0) {
    // The agent hands the line over; only the owner's own comment approves anything.
    io.out(
      `${either(accounts.owners)} answers ${waiting.size === 1 ? 'it' : `all ${waiting.size}`} with one comment on ${GITHUB_WEB}/${slug}/issues/${accounts.approvals}, the Approvals issue, whose first line is this (deleting a number leaves that one waiting):`,
    );
    // The issues asked for come first, in the order given; what else waits on their slices follows.
    const ordered = new Set([...numbers.filter((number) => waiting.has(number)), ...waiting]);
    io.out(`Decision: approve ${[...ordered].map((number) => `#${number}`).join(' ')}`);
  }
  return code;
}

/**
 * `propose` for one issue: its exit code, and the issues whose proposals
 * still wait on the owner, each the number a batch answer names.
 */
async function proposeOne(
  sys: Sys,
  io: Output,
  token: string,
  slug: string,
  accounts: Settings,
  number: number,
): Promise<{ code: number; waiting: number[] }> {
  const issue = await readIssue(sys, token, slug, number);
  const { parent, problem } = issue?.type?.name === 'State' ? await parentOf(sys, token, issue) : {};
  if (problem) return { code: report(io, 'propose', [problem]), waiting: [] };
  const state = parent?.type?.name === 'Slice';
  const slice = state ? parent.number : number;
  const read = await readSlice(sys, token, slug, slice, accounts);
  if (read.problems.length > 0) return { code: report(io, 'propose', read.problems), waiting: [] };
  const owner = either(accounts.owners);
  const asked = read.owed.filter((one) => !state || one.number === number);
  if (asked.length === 0) {
    io.out(`propose: #${number} needs no decision from ${owner}`);
    return { code: 0, waiting: [] };
  }

  // A proposal says what it asks for, so one whose body cannot say it is not posted.
  const gaps = asked.filter((one) => !one.settled && one.proposals.length === 0).map(proposalGap).filter((gap) => gap !== undefined);
  if (gaps.length > 0) return { code: report(io, 'propose', gaps), waiting: [] };

  const issues = `${API}/repos/${slug}/issues/${slice}`;
  // Each link opens the very comment the owner reacts 👍 to, never the slice's top or a label's list.
  const links = new Map<Owed, string | undefined>();
  for (const one of asked) {
    const what = one.kind === 'added' ? `#${slice}` : `state #${one.number}`;
    if (one.settled) {
      io.out(`✓ ${what}: ${owner} has decided`);
    } else if (one.proposals.length > 0) {
      links.set(one, newest(one.proposals).html_url);
      io.out(`${what}: proposed on #${slice}, waiting on ${owner}'s 👍: ${links.get(one)}`);
    } else {
      const posted = await sys.http(`${issues}/comments`, { method: 'POST', token, body: { body: proposalBody(one, slice, read.parent, accounts) } });
      if (posted.status !== 201) throw new Error(`cannot comment on #${slice} (HTTP ${posted.status})`);
      const url = (posted.json as { html_url?: string } | null)?.html_url;
      links.set(one, url);
      io.out(`✓ ${what}: proposed on #${slice}${url ? `: ${url}` : ''}`);
    }
  }
  const waiting = read.owed.filter((one) => !one.settled);
  if (waiting.length > 0) {
    const labeled = await sys.http(`${issues}/labels`, { method: 'POST', token, body: { labels: [NEEDS_OWNER] } });
    if (labeled.status !== 200) throw new Error(`cannot label #${slice} ${NEEDS_OWNER} (HTTP ${labeled.status})`);
    // A decision this run did not ask for still has its proposal's link, or the command that posts one.
    for (const one of waiting) if (!links.has(one) && one.proposals.length > 0) links.set(one, newest(one.proposals).html_url);
    const unproposed = waiting.filter((one) => !links.has(one)).map((one) => `; ${either(accounts.agents)} proposes #${one.number} with: process-rules propose ${one.number}`);
    const urls = [...links.values()].filter((url) => url !== undefined);
    const where = urls.length > 0 ? `, waiting on ${owner}'s 👍 on ${urls.join(' and ')}` : '';
    io.out(`#${slice} is labeled ${NEEDS_OWNER}${where}${unproposed.join('')}`);
    // Only what the owner can read a proposal for goes into a batch answer.
    return { code: 0, waiting: waiting.filter((one) => links.has(one)).map((one) => one.number) };
  }
  const removed = await sys.http(`${issues}/labels/${NEEDS_OWNER}`, { method: 'DELETE', token });
  // 404: the slice had no such label.
  if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot take ${NEEDS_OWNER} off #${slice} (HTTP ${removed.status})`);
  io.out(`✓ #${slice}: nothing waits on ${owner}`);
  return { code: 0, waiting: [] };
}
