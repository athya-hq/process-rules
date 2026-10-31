import { API, NO_TOKEN, loadSettings, repoAt, sameLogin } from './agent.ts';
import { isOn, notAdoptedLine, offLine } from './features.ts';
import { agentSession, pushIdentityProblem } from './push-identity.ts';
import type { Output, Sys } from './types.ts';

/** How a pull request or a commit names the slice it builds. */
const SLICE_LINE = /^Slice:\s*(?:#|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)(\d+)\s*$/gim;

/** The slices `text` names, in order, without repeats. */
export function slicesNamed(text: string): number[] {
  return [...new Set([...text.matchAll(SLICE_LINE)].map((match) => Number(match[1])))];
}

interface Comment {
  id: string;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  lastEditedAt: string | null;
}

type TimelineItem =
  | { __typename: 'LabeledEvent' | 'UnlabeledEvent'; createdAt: string; actor: { login: string } | null; label: { name: string } }
  | { __typename: 'SubIssueAddedEvent'; createdAt: string; subIssue: { number: number } | null }
  | ({ __typename: 'IssueComment' } & Comment);

interface Page {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface EarlierPage {
  hasPreviousPage: boolean;
  startCursor: string | null;
}

interface StateNode {
  id: string;
  number: number;
  title: string;
  issueType: { name: string } | null;
  stateReason: string | null;
  closedAt: string | null;
  comments: { nodes: Comment[]; pageInfo?: EarlierPage };
}

interface SliceGraph {
  id: string;
  number: number;
  title: string;
  issueType: { name: string } | null;
  comments: { nodes: Comment[]; pageInfo?: EarlierPage };
  parent: { id: string; number: number; issueType: { name: string } | null } | null;
  subIssues: { nodes: StateNode[]; pageInfo?: Page };
}

const COMMENT = 'id author { login } body createdAt lastEditedAt';
/** A slice's sub-issues, with their latest comments; earlier ones are read only for the states that need them. */
const STATE = `id number title issueType { name } stateReason closedAt comments(last: 100) { nodes { ${COMMENT} } pageInfo { hasPreviousPage startCursor } }`;
const SLICE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title issueType { name } comments(last: 100) { nodes { ${COMMENT} } pageInfo { hasPreviousPage startCursor } }
      parent { id number issueType { name } }
      subIssues(first: 100) { nodes { ${STATE} } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
/** The work item's approvals, additions and comments, 100 a page: GitHub's most. */
const TIMELINE_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on Issue {
      timelineItems(first: 100, after: $after, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, SUB_ISSUE_ADDED_EVENT, ISSUE_COMMENT]) {
        nodes {
          __typename
          ... on LabeledEvent { createdAt actor { login } label { name } }
          ... on UnlabeledEvent { createdAt actor { login } label { name } }
          ... on SubIssueAddedEvent { createdAt subIssue { number } }
          ... on IssueComment { ${COMMENT} }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
/** A slice's further sub-issues, 100 a page. */
const SUB_ISSUES_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on Issue { subIssues(first: 100, after: $after) { nodes { ${STATE} } pageInfo { hasNextPage endCursor } } } }
}`;
/** An issue's earlier comments, 100 a page, newest page first. */
const COMMENTS_QUERY = `query($id: ID!, $before: String) {
  node(id: $id) { ... on Issue { comments(last: 100, before: $before) { nodes { ${COMMENT} } pageInfo { hasPreviousPage startCursor } } } }
}`;
/** The 👍 reactions on some comments, by comment id; GitHub reads 100 ids at a time. */
const THUMBS_UP_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on IssueComment { id reactions(content: THUMBS_UP, first: 100) { nodes { user { login } createdAt } pageInfo { hasNextPage } } } }
}`;

async function graphql(sys: Sys, token: string, slice: number, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query, variables } });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status !== 200 || reply?.errors?.length) {
    const why = reply?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${status}`;
    // A client workflow from before the work rules grants no issues: read.
    const hint = /not accessible/i.test(why) ? '; the client workflow needs issues: read, so run process-rules onboard to update it' : '';
    throw new Error(`cannot read #${slice}: ${why}${hint}`);
  }
  return reply?.data;
}

/** Whether the owner left a `Decision:` comment among `comments`, after `since` when given, mentioning `mention` when given. */
function decided(comments: Comment[], owner: string, since?: string, mention?: string): boolean {
  return comments.some(
    (comment) =>
      sameLogin(comment.author?.login, owner) &&
      /^\s*Decision:/i.test(comment.body) &&
      (!since || comment.createdAt > since) &&
      (!mention || new RegExp(`${mention}\\b`).test(comment.body)),
  );
}

/** A proposal's first line, and the issue it names first: what the proposal is for. */
const PROPOSAL = /^\s*Proposal:[^#\n]*#(\d+)\b/i;

/** The agent's proposals among `comments` for issue `number`. */
function proposalsFor(comments: Comment[], agent: string, number: number): Comment[] {
  return comments.filter((comment) => sameLogin(comment.author?.login, agent) && Number(PROPOSAL.exec(comment.body)?.[1]) === number);
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
function thumbsUp(proposals: Comment[], reactions: Map<string, { user: { login: string } | null; createdAt: string }[]>, owner: string, since?: string): boolean {
  return proposals.some((proposal) =>
    (reactions.get(proposal.id) ?? []).some(
      (reaction) =>
        sameLogin(reaction.user?.login, owner) &&
        (!since || reaction.createdAt > since) &&
        (!proposal.lastEditedAt || reaction.createdAt > proposal.lastEditedAt),
    ),
  );
}

/** All of an issue's comments: `latest`, the newest page read already, and every page before it. */
async function allComments(sys: Sys, token: string, slice: number, id: string, latest: { nodes: Comment[]; pageInfo?: EarlierPage }): Promise<Comment[]> {
  const comments = [...latest.nodes];
  for (let info = latest.pageInfo; info?.hasPreviousPage; ) {
    const page = (await graphql(sys, token, slice, COMMENTS_QUERY, { id, before: info.startCursor })) as {
      node: { comments: { nodes: Comment[]; pageInfo: EarlierPage } };
    };
    comments.unshift(...page.node.comments.nodes);
    info = page.node.comments.pageInfo;
  }
  return comments;
}

async function sliceGraph(sys: Sys, token: string, slug: string, number: number): Promise<SliceGraph | undefined> {
  const [repoOwner, name] = slug.split('/');
  const data = (await graphql(sys, token, number, SLICE_QUERY, { owner: repoOwner, name, number })) as {
    repository?: { issue?: SliceGraph | null } | null;
  } | undefined;
  return data?.repository?.issue ?? undefined;
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
  const issue = await sliceGraph(sys, token, slug, slice);
  if (!issue) return { problems: [`#${slice} is not an issue in ${slug}`], owed: [] };
  if (issue.issueType?.name !== 'Slice') return { problems: [`#${slice} is not a Slice (its type is ${issue.issueType?.name ?? 'none'})`], owed: [] };
  const parent = issue.parent;
  if (parent?.issueType?.name !== 'Work item') return { problems: [`#${slice} is not a sub-issue of a Work item`], owed: [] };

  const events: TimelineItem[] = [];
  for (let after: string | null = null; ; ) {
    const page = (await graphql(sys, token, slice, TIMELINE_QUERY, { id: parent.id, after })) as {
      node: { timelineItems: { nodes: TimelineItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    };
    events.push(...page.node.timelineItems.nodes);
    if (!page.node.timelineItems.pageInfo.hasNextPage) break;
    after = page.node.timelineItems.pageInfo.endCursor;
  }
  const approval = events.filter(
    (event): event is Extract<TimelineItem, { __typename: 'LabeledEvent' | 'UnlabeledEvent' }> =>
      (event.__typename === 'LabeledEvent' || event.__typename === 'UnlabeledEvent') && event.label.name === 'approved',
  ).at(-1);
  if (approval?.__typename !== 'LabeledEvent') {
    return { problems: [`work item #${parent.number} is not approved: ${owner} adds the approved label before any slice starts`], owed: [] };
  }
  if (!sameLogin(approval.actor?.login, owner)) {
    return { problems: [`work item #${parent.number} was labeled approved by ${approval.actor?.login ?? 'someone unknown'}, not ${owner}`], owed: [] };
  }
  const approvedAt = approval.createdAt;
  const parentComments = events.filter((event): event is { __typename: 'IssueComment' } & Comment => event.__typename === 'IssueComment');
  // Every comment on the slice, so a proposal or decision that later discussion pushed back still counts.
  const comments = await allComments(sys, token, slice, issue.id, issue.comments);
  // Every state, however many: one past the first page can be a dropped one.
  const states = [...issue.subIssues.nodes];
  for (let info = issue.subIssues.pageInfo; info?.hasNextPage; ) {
    const page = (await graphql(sys, token, slice, SUB_ISSUES_QUERY, { id: issue.id, after: info.endCursor })) as {
      node: { subIssues: { nodes: StateNode[]; pageInfo: Page } };
    };
    states.push(...page.node.subIssues.nodes);
    info = page.node.subIssues.pageInfo;
  }

  const owed: Owed[] = [];
  // The latest addition counts: a slice removed and added again after approval needs the owner's say.
  const added = events
    .filter(
      (event): event is Extract<TimelineItem, { __typename: 'SubIssueAddedEvent' }> =>
        event.__typename === 'SubIssueAddedEvent' && event.subIssue?.number === slice,
    )
    .at(-1);
  if (added && added.createdAt > approvedAt) {
    owed.push({
      kind: 'added',
      number: slice,
      title: issue.title,
      since: added.createdAt,
      proposals: proposalsFor(comments, agent, slice),
      settled: decided(parentComments, owner, added.createdAt, `#${slice}`) || decided(comments, owner, added.createdAt),
    });
  }
  for (const state of states) {
    if (state.issueType?.name !== 'State' || state.stateReason !== 'NOT_PLANNED' || !state.closedAt || state.closedAt < approvedAt) continue;
    owed.push({
      kind: 'dropped',
      number: state.number,
      title: state.title,
      proposals: proposalsFor(comments, agent, state.number),
      settled: decided(comments, owner, undefined, `#${state.number}`) || decided(await allComments(sys, token, slice, state.id, state.comments), owner),
    });
  }

  // Reactions are read only for the proposals that could still settle something.
  const ids = owed.filter((one) => !one.settled).flatMap((one) => one.proposals.map((proposal) => proposal.id));
  const reactions = new Map<string, { user: { login: string } | null; createdAt: string }[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const data = (await graphql(sys, token, slice, THUMBS_UP_QUERY, { ids: ids.slice(i, i + 100) })) as {
      nodes: ({ id: string; reactions: { nodes: { user: { login: string } | null; createdAt: string }[]; pageInfo?: Page } } | null)[];
    };
    for (const node of data.nodes) {
      if (!node) continue;
      // GitHub reads one comment's reactions at a time past the first 100; a proposal with that many is refused, never half read.
      if (node.reactions.pageInfo?.hasNextPage) throw new Error(`cannot read #${slice}: a proposal on it has more than 100 👍 reactions, more than the work rules read`);
      reactions.set(node.id, node.reactions.nodes);
    }
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
  const token = sys.env.GH_TOKEN;
  if (!token || token === NO_TOKEN) {
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
  const token = sys.env.GH_TOKEN;
  if (!token || token === NO_TOKEN) return report(io, 'propose', ['this session has no token; run process-rules doctor']);
  // Only the agent's proposals count, so one posted as anyone else would wait for nothing.
  const user = await sys.http(`${API}/user`, { token });
  const login = (user.json as { login?: string } | null)?.login;
  if (user.status !== 200 || !sameLogin(login, accounts.agent)) {
    return report(io, 'propose', [`propose posts as ${accounts.agent}, but this session's token is ${login ?? 'refused'}`]);
  }

  const issue = await sliceGraph(sys, token, slug, number);
  const state = issue?.issueType?.name === 'State' && issue.parent?.issueType?.name === 'Slice';
  const slice = state ? (issue.parent?.number as number) : number;
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
