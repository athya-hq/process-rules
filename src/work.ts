import { API, loadSettings, repoAt, sameLogin } from './agent.ts';
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

interface SliceGraph {
  number: number;
  issueType: { name: string } | null;
  comments: { nodes: Comment[] };
  parent: {
    number: number;
    issueType: { name: string } | null;
    timelineItems: {
      nodes: (
        | { __typename: 'LabeledEvent' | 'UnlabeledEvent'; createdAt: string; actor: { login: string } | null; label: { name: string } }
        | { __typename: 'SubIssueAddedEvent'; createdAt: string; subIssue: { number: number } | null }
        | ({ __typename: 'IssueComment' } & Comment)
      )[];
    };
  } | null;
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
      parent {
        number issueType { name }
        timelineItems(last: 200, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, SUB_ISSUE_ADDED_EVENT, ISSUE_COMMENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login } label { name } }
            ... on UnlabeledEvent { createdAt actor { login } label { name } }
            ... on SubIssueAddedEvent { createdAt subIssue { number } }
            ... on IssueComment { ${COMMENT} }
          }
        }
      }
      subIssues(first: 100) { nodes { number issueType { name } stateReason closedAt comments(last: 50) { nodes { ${COMMENT} } } } }
    }
  }
}`;

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
  const [repoOwner, name] = slug.split('/');
  const { status, json } = await sys.http(`${API}/graphql`, {
    method: 'POST',
    token,
    body: { query: SLICE_QUERY, variables: { owner: repoOwner, name, number: slice } },
  });
  const reply = json as { data?: { repository?: { issue?: SliceGraph | null } | null }; errors?: { message?: string }[] } | null;
  if (status !== 200 || reply?.errors?.length) {
    throw new Error(`cannot read #${slice}: ${reply?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${status}`}`);
  }
  const issue = reply?.data?.repository?.issue;
  if (!issue) return [`#${slice} is not an issue in ${slug}`];
  if (issue.issueType?.name !== 'Slice') return [`#${slice} is not a Slice (its type is ${issue.issueType?.name ?? 'none'})`];
  const parent = issue.parent;
  if (parent?.issueType?.name !== 'Work item') return [`#${slice} is not a sub-issue of a Work item`];

  const problems: string[] = [];
  const events = parent.timelineItems.nodes;
  const approval = events.filter(
    (event): event is Extract<typeof event, { __typename: 'LabeledEvent' | 'UnlabeledEvent' }> =>
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

  const added = events.find(
    (event): event is Extract<typeof event, { __typename: 'SubIssueAddedEvent' }> =>
      event.__typename === 'SubIssueAddedEvent' && event.subIssue?.number === slice,
  );
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
    for (const pull of pulls.json as { number: number; body: string | null; head: { ref: string } }[]) {
      if (pull.number === mine.pull || pull.head.ref === mine.branch) continue;
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
  const { owner, agent } = loadSettings(sys, sys.cwd);
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

/**
 * The work rules before a push from an agent session, run by the client's
 * pre-push git hook with git's ref lines on stdin. The commits pushed must
 * name exactly one slice between them, as a trailer `Slice: #N`, that may be
 * built. Pushes outside agent sessions pass.
 */
export async function prePush(sys: Sys, io: Output, refLines: string): Promise<number> {
  const token = sys.env.GH_TOKEN;
  if (!sys.env.PROCESS_RULES_AGENT || !token) return 0;
  const { root, slug } = repoAt(sys);
  const { owner } = loadSettings(sys, root);
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, local, remoteRef, remote] = line.split(' ');
    if (!local || !remoteRef || ZERO.test(local)) continue;
    const range = remote && !ZERO.test(remote) ? [`${remote}..${local}`] : [local, '--not', '--remotes'];
    const messages = sys.exec('git', ['log', '--format=%B', ...range], { cwd: root });
    if (messages.code !== 0) throw new Error(`git log failed: ${messages.stderr.trim()}`);
    if (!messages.stdout.trim()) continue;
    const slices = slicesNamed(messages.stdout);
    const branch = remoteRef.replace(/^refs\/heads\//, '');
    if (slices.length !== 1) {
      return report(io, 'pre-push', [
        slices.length === 0
          ? `the commits for ${branch} name no slice; add a trailer "Slice: #N" to a commit message`
          : `the commits for ${branch} name ${slices.length} slices (${slices.map((n) => `#${n}`).join(', ')}); one push builds one slice`,
      ]);
    }
    const [slice] = slices as [number];
    const code = report(io, 'pre-push', await sliceProblems(sys, token, slug, slice, owner, { branch }));
    if (code !== 0) return code;
  }
  return 0;
}
