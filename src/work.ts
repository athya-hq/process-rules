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
  author: { login: string } | null;
  body: string;
  createdAt: string;
}

type TimelineItem =
  | { __typename: 'LabeledEvent' | 'UnlabeledEvent'; createdAt: string; actor: { login: string } | null; label: { name: string } }
  | { __typename: 'SubIssueAddedEvent'; createdAt: string; subIssue: { number: number } | null }
  | ({ __typename: 'IssueComment' } & Comment);

interface SliceGraph {
  number: number;
  issueType: { name: string } | null;
  comments: { nodes: Comment[] };
  parent: { id: string; number: number; issueType: { name: string } | null } | null;
  subIssues: {
    nodes: {
      number: number;
      issueType: { name: string } | null;
      stateReason: string | null;
      closedAt: string | null;
      comments: { nodes: Comment[] };
    }[];
  };
}

const COMMENT = 'author { login } body createdAt';
const SLICE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number issueType { name } comments(last: 100) { nodes { ${COMMENT} } }
      parent { id number issueType { name } }
      subIssues(first: 100) { nodes { number issueType { name } stateReason closedAt comments(last: 50) { nodes { ${COMMENT} } } } }
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

/**
 * The work rules for building one slice, as problems; none means it may be
 * built: the slice is a Slice under a Work item the owner approved; a slice
 * added after the approval, and an approved State closed as not planned, each
 * carry the owner's `Decision:` comment; and no other open pull request
 * builds the slice.
 */
export async function sliceProblems(
  sys: Sys,
  token: string,
  slug: string,
  slice: number,
  owner: string,
  mine: { pull?: number; branch?: string },
): Promise<string[]> {
  // The pull request being checked: by number, or by its branch in this repository (not a fork's of the same name).
  const [repoOwner, name] = slug.split('/');
  const data = (await graphql(sys, token, slice, SLICE_QUERY, { owner: repoOwner, name, number: slice })) as {
    repository?: { issue?: SliceGraph | null } | null;
  } | undefined;
  const issue = data?.repository?.issue;
  if (!issue) return [`#${slice} is not an issue in ${slug}`];
  if (issue.issueType?.name !== 'Slice') return [`#${slice} is not a Slice (its type is ${issue.issueType?.name ?? 'none'})`];
  const parent = issue.parent;
  if (parent?.issueType?.name !== 'Work item') return [`#${slice} is not a sub-issue of a Work item`];

  const problems: string[] = [];
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
    return [`work item #${parent.number} is not approved: ${owner} adds the approved label before any slice starts`];
  }
  if (!sameLogin(approval.actor?.login, owner)) {
    return [`work item #${parent.number} was labeled approved by ${approval.actor?.login ?? 'someone unknown'}, not ${owner}`];
  }
  const approvedAt = approval.createdAt;
  const parentComments = events.filter((event): event is { __typename: 'IssueComment' } & Comment => event.__typename === 'IssueComment');

  // The latest addition counts: a slice removed and added again after approval needs the owner's say.
  const added = events
    .filter(
      (event): event is Extract<TimelineItem, { __typename: 'SubIssueAddedEvent' }> =>
        event.__typename === 'SubIssueAddedEvent' && event.subIssue?.number === slice,
    )
    .at(-1);
  if (
    added &&
    added.createdAt > approvedAt &&
    !decided(parentComments, owner, added.createdAt, `#${slice}`) &&
    !decided(issue.comments.nodes, owner, added.createdAt)
  ) {
    problems.push(`#${slice} was added to work item #${parent.number} after its approval; ${owner} adds a "Decision:" comment naming #${slice}`);
  }

  for (const state of issue.subIssues.nodes) {
    if (state.issueType?.name !== 'State' || state.stateReason !== 'NOT_PLANNED' || !state.closedAt || state.closedAt < approvedAt) continue;
    if (!decided(state.comments.nodes, owner) && !decided(issue.comments.nodes, owner, undefined, `#${state.number}`)) {
      problems.push(`state #${state.number} was closed as not planned after approval; ${owner} adds a "Decision:" comment to it`);
    }
  }

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
  const problems = await sliceProblems(sys, token, slug, slice, owner, { pull: pull.number });
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
export async function prePush(sys: Sys, io: Output, refLines: string, url = ''): Promise<number> {
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
  return report(io, 'pre-push', await sliceProblems(sys, token, slug, slice, owner, { branch: branches[0] as string }));
}
