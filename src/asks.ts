import { API, type Settings, anyLogin, loadSettings } from './agent.ts';
import { ownersAlone } from './edits.ts';
import { approvedIn, batchAnswers, firstIssue } from './approvals.ts';
import { isOn, notAdoptedLine, offLine } from './features.ts';
import { type ReadFile, type Simple, type Text, UNKNOWN, commands } from './shell.ts';
import type { Output, Sys } from './types.ts';

/** The label an ask puts on its issue, which the board's "Needs you" view lists. */
export const NEEDS_OWNER = 'needs-owner';
/** The longest comment that may ask the owner, in characters: the question, the page link and how to answer. */
export const ASK_LIMIT = 500;
/** A published page: a claude.ai artifact, as a session publishes it. */
export const PAGE_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;
/** The hourly sweep's cron, which the client's workflow and the shared one both name. */
export { HOURLY } from './features.ts';

/** A comment's opening word, past any Markdown emphasis, heading or quote marks before it. */
const OPENING = /^\s*(?:[*_#>]+\s*)*([A-Za-z][A-Za-z ]*?):/;

/** The ask a comment opens with, `Needs you` or `Proposal`, or undefined. */
export function opensAsk(body: string): string | undefined {
  const word = OPENING.exec(body)?.[1];
  return word === 'Needs you' || word === 'Proposal' ? word : undefined;
}

/** Whether a comment opens with `Decision:`, the owner's word. */
export function opensDecision(body: string): boolean {
  return OPENING.exec(body)?.[1] === 'Decision';
}

/** The first of `owners` a comment names, with or without an @, or undefined. */
function namedOwner(body: string, owners: readonly string[]): string | undefined {
  return owners.find((owner) => new RegExp(`(?<![\\w-])@?${owner}(?![\\w-])`, 'i').test(body));
}

/** Why a comment counts as asking the owner, or undefined when it does not. */
export function askedBy(body: string, owners: readonly string[]): string | undefined {
  const ask = opensAsk(body);
  if (ask) return `it opens with "${ask}:"`;
  const owner = namedOwner(body, owners);
  return owner ? `it names the owner, ${owner}` : undefined;
}

/**
 * Why a comment body may not be posted, or undefined when it may: one that
 * asks the owner links a published page and fits ASK_LIMIT characters. A
 * body with parts only the running shell knows is judged on the parts it
 * spells out; where those ask the owner, or it opens with an unknown part,
 * the guard cannot measure it, so it is refused with how to write it.
 */
export function askProblem(body: Text, owners: readonly string[]): string | undefined {
  if (body.opensUnknown) {
    return 'the guard cannot see how this comment opens, since it starts with a part only the shell knows (a variable or a command substitution) or comes from an editor, a prompt or the browser, so it cannot tell whether it asks the owner';
  }
  const why = askedBy(body.text.replaceAll(UNKNOWN, ' '), owners);
  if (!why) return undefined;
  if (!body.known) {
    return `this comment asks the owner (${why}), and the guard cannot measure it, since part of it only the shell knows (a variable or a command substitution)`;
  }
  const length = [...body.text.trim()].length;
  const missing = PAGE_LINK.test(body.text) ? [] : ['links no published page (https://claude.ai/artifact/… or https://claude.ai/code/artifact/…)'];
  const long = length > ASK_LIMIT ? [`runs ${length} characters, over ${ASK_LIMIT}`] : [];
  const problems = [...missing, ...long];
  return problems.length === 0 ? undefined : `this comment asks the owner (${why}), and it ${problems.join(' and ')}`;
}

/** The refusal the guard prints for an ask that breaks the rule. */
export function askRefusal(problem: string): string {
  return (
    `process-rules: refused, because ${problem}. ` +
    'The rule: anything the owner must read, approve or choose arrives as a published page; the comment carries only the question, the page link and how to answer, ' +
    `in ${ASK_LIMIT} characters or fewer. ` +
    `Fix: publish the page first, then post a comment of at most ${ASK_LIMIT} characters that links it, ` +
    "written out in the command (quoted text, a quoted heredoc <<'EOF', or --body-file <file>) so the guard can read it."
  );
}

/** A gh command's flags that take a value, so the word after them is not an argument. */
const GH_VALUED = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-f', '--raw-field', '--field', '--input', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
/** gh api endpoints that create or edit a comment: an issue's or pull request's, a review comment's, or a reply to one. */
const COMMENT_ENDPOINT = /\/comments(?:\/\d+)?(?:\/replies)?\/?(?:\?|$)/;
/** GraphQL mutations that post or edit a comment. */
const COMMENT_MUTATION = /\b(?:addComment|updateIssueComment|addPullRequestReviewComment|addPullRequestReviewThreadReply|updatePullRequestReviewComment)\b/;

/** One flag's value, as `--flag value`, `--flag=value` or `-fvalue`, where `at` names the flag; undefined when it is not one. */
function flagValue(words: Text[], at: number, names: readonly string[]): { value: Text | undefined; next: number } | undefined {
  const word = words[at] as Text;
  for (const name of names) {
    if (word.text === name) return { value: words[at + 1], next: at + 2 };
    const joined = name.startsWith('--') ? `${name}=` : name;
    if (word.text.startsWith(joined) && word.text.length > joined.length) {
      const text = word.text.slice(joined.length);
      return { value: { ...word, text, opensUnknown: text.startsWith(UNKNOWN) }, next: at + 1 };
    }
  }
  return undefined;
}

const UNREADABLE = (what: string): Text => ({ text: what, known: false, opensUnknown: true });

/** A body read from a file a flag names: `-` is the command's standard input. */
function fromFile(path: Text | undefined, simple: Simple, read: ReadFile): Text {
  if (!path?.known) return UNREADABLE('');
  if (path.text === '-') return simple.stdin ?? UNREADABLE('');
  const text = read(path.text);
  return text === undefined ? UNREADABLE('') : { text, known: true, opensUnknown: false };
}

/**
 * The body a `gh issue comment` or `gh pr comment` posts; undefined only for
 * `--delete-last`, which posts none. With no body in the command, gh takes
 * it from an editor, a prompt or the browser, which the guard cannot read.
 */
function commentBody(args: Text[], simple: Simple, read: ReadFile): Text | undefined {
  let body: Text | undefined;
  for (let at = 0; at < args.length; ) {
    const inline = flagValue(args, at, ['--body', '-b']);
    const file = inline ? undefined : flagValue(args, at, ['--body-file', '-F']);
    if (inline) body = inline.value ?? UNREADABLE('');
    else if (file) body = fromFile(file.value, simple, read);
    at = inline?.next ?? file?.next ?? at + 1;
  }
  if (body) return body;
  return args.some((word) => word.text === '--delete-last') ? undefined : UNREADABLE('');
}

/** A body written into a GraphQL query as `body: "…"`, read as GraphQL reads the string, or undefined. */
function queryBody(query: Text): Text | undefined {
  const written = /\bbody\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(query.text)?.[1];
  if (written === undefined) return undefined;
  try {
    const text = JSON.parse(`"${written}"`) as string;
    return { text, known: query.known && !text.includes(UNKNOWN), opensUnknown: text.startsWith(UNKNOWN) };
  } catch {
    return UNREADABLE('');
  }
}

/** The words of a gh command that are not flags or a flag's value, in order. */
function positionals(args: Text[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const word = (args[at] as Text).text;
    if (!word.startsWith('-')) found.push(word);
    else if (GH_VALUED.has(word)) at++;
  }
  return found;
}

/** A `key=value` field of gh api, its value read as -F reads it (`@file`) when `typed`. */
function field(value: Text, typed: boolean, simple: Simple, read: ReadFile): { key: string; value: Text } | undefined {
  const equals = value.text.indexOf('=');
  if (equals < 0) return undefined;
  const raw: Text = { ...value, text: value.text.slice(equals + 1), opensUnknown: value.text.slice(equals + 1).startsWith(UNKNOWN) };
  const key = value.text.slice(0, equals);
  if (typed && raw.known && raw.text.startsWith('@')) return { key, value: fromFile({ ...raw, text: raw.text.slice(1) }, simple, read) };
  return { key, value: raw };
}

/** The body a `gh api` call posts to a comment endpoint or in a comment mutation, or undefined when it posts none. */
function apiBody(args: Text[], simple: Simple, read: ReadFile): Text | undefined {
  let endpoint: string | undefined;
  const fields = new Map<string, Text>();
  let input: Text | undefined;
  for (let at = 0; at < args.length; ) {
    const word = args[at] as Text;
    const raw = flagValue(args, at, ['--raw-field', '-f']);
    const typed = raw ? undefined : flagValue(args, at, ['--field', '-F']);
    const given = raw ? undefined : typed ? undefined : flagValue(args, at, ['--input']);
    if (raw?.value || typed?.value) {
      const parsed = field((raw?.value ?? typed?.value) as Text, Boolean(typed), simple, read);
      if (parsed) fields.set(parsed.key, parsed.value);
    } else if (given) {
      input = fromFile(given.value, simple, read);
    } else if (!word.text.startsWith('-') && endpoint === undefined) {
      endpoint = word.text;
    }
    const next = raw?.next ?? typed?.next ?? given?.next;
    at = next ?? (GH_VALUED.has(word.text) ? at + 2 : at + 1);
  }
  const query = fields.get('query');
  const comment = endpoint === 'graphql' ? Boolean(query && COMMENT_MUTATION.test(query.text)) : endpoint !== undefined && COMMENT_ENDPOINT.test(endpoint);
  if (!comment) return undefined;
  // A mutation names its body's variable as `body: $name`; gh passes each variable as a field of that name.
  const variable = endpoint === 'graphql' && query ? /\bbody\s*:\s*\$(\w+)/.exec(query.text)?.[1] : undefined;
  const body = fields.get(variable ?? 'body');
  if (body) return body;
  if (input) {
    if (!input.known) return input;
    try {
      const parsed = JSON.parse(input.text) as { body?: unknown; variables?: { body?: unknown } } | null;
      const text = parsed?.body ?? parsed?.variables?.body;
      return typeof text === 'string' ? { text, known: true, opensUnknown: false } : undefined;
    } catch {
      return UNREADABLE('');
    }
  }
  // A mutation with its body written into the query: that string, or else the whole query.
  return endpoint === 'graphql' && query ? (queryBody(query) ?? query) : undefined;
}

/** The comment bodies a command line posts or edits through gh, each as the command spells it. */
export function commentBodies(line: string, read: ReadFile): Text[] {
  const bodies: Text[] = [];
  for (const simple of commands(line, read)) {
    const at = simple.words.findIndex((word) => word.known && /^(?:.*\/)?gh$/.test(word.text));
    if (at < 0) continue;
    const args = simple.words.slice(at + 1);
    const [group, action] = positionals(args);
    const body =
      (group === 'issue' || group === 'pr') && action === 'comment'
        ? commentBody(args, simple, read)
        : group === 'api'
          ? apiBody(args.slice(args.findIndex((word) => word.text === 'api') + 1), simple, read)
          : undefined;
    if (body) bodies.push(body);
  }
  return bodies;
}

/** The repository settings' owners for a command run in `cwd`: the nearest folder up that has them; none outside a client. */
export function ownersAround(sys: Sys, cwd: string): string[] {
  for (let dir = cwd; ; dir = dir.replace(/\/[^/]*$/, '')) {
    if (sys.exists(`${dir}/.github/process-rules.json`)) {
      try {
        return loadSettings(sys, dir).owners;
      } catch {
        return [];
      }
    }
    if (!dir.includes('/') || dir === '') return [];
  }
}

/**
 * The guard's comment check: the first problem with a comment the command
 * would post through gh, or undefined. Files the command names are read
 * relative to `cwd`, where it runs.
 */
export function commentProblem(sys: Sys, line: string, cwd: string): string | undefined {
  const read: ReadFile = (path) => {
    const full = path.startsWith('/') ? path : path.startsWith('~/') ? `${sys.home}${path.slice(1)}` : `${cwd}/${path}`;
    return sys.exists(full) ? sys.read(full) : undefined;
  };
  const bodies = commentBodies(line, read);
  if (bodies.length === 0) return undefined;
  const owners = ownersAround(sys, cwd);
  for (const body of bodies) {
    const problem = askProblem(body, owners);
    if (problem) return problem;
  }
  return undefined;
}

interface Comment {
  id: number;
  /** Its GraphQL id, from which its edits are read. */
  node_id?: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at: string;
  updated_at?: string;
}

interface Reaction {
  user?: { login?: string } | null;
  created_at: string;
}

/** Every page of a list GitHub returns; none on 404 when `missing` allows it. */
async function every<T>(sys: Sys, token: string, url: string, missing = false): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token });
    if (status === 404 && missing) return items;
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${url.replace(API, '')} (HTTP ${status})`);
    items.push(...(json as T[]));
    if (json.length < 100) return items;
  }
}

async function addLabel(sys: Sys, token: string, slug: string, number: number): Promise<void> {
  const added = await sys.http(`${API}/repos/${slug}/issues/${number}/labels`, { method: 'POST', token, body: { labels: [NEEDS_OWNER] } });
  if (added.status !== 200) throw new Error(`cannot label #${number} ${NEEDS_OWNER} (HTTP ${added.status})`);
}

/** Takes the label off; one already gone is fine. Whether it was on. */
async function removeLabel(sys: Sys, token: string, slug: string, number: number): Promise<boolean> {
  const removed = await sys.http(`${API}/repos/${slug}/issues/${number}/labels/${NEEDS_OWNER}`, { method: 'DELETE', token });
  if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot take ${NEEDS_OWNER} off #${number} (HTTP ${removed.status})`);
  return removed.status === 200;
}

/** An ask the owner owes an answer on an issue, and the issue a batch answer names to answer it. */
interface Owed {
  ask: Comment;
  number: number;
  kind: 'Needs you' | 'Proposal';
  /** The owner's answer counts only after this: the ask, or for a slice's addition its latest addition, if later. */
  since: string;
}

/**
 * The asks the owner owes on issue `number`, from its comments: each agent
 * `Proposal:`, for the issue its first line names first (this repository's
 * `#N`, as a batch answer names it: a slice for its addition, a State for
 * its drop; the issue itself when it names none), and the latest agent ask
 * when it is a `Needs you:`, for the issue itself.
 */
function owedOn(comments: Comment[], agents: string[], number: number): Owed[] {
  const asks = comments.filter((comment) => anyLogin(agents, comment.user?.login ?? undefined) && opensAsk(comment.body ?? ''));
  return asks.flatMap((ask, at): Owed[] => {
    const body = ask.body ?? '';
    if (opensAsk(body) === 'Proposal') return [{ ask, number: firstIssue(body.split(/\r?\n/, 1)[0] as string) ?? number, kind: 'Proposal', since: ask.created_at }];
    return at === asks.length - 1 ? [{ ask, number, kind: 'Needs you', since: ask.created_at }] : [];
  });
}

/** How the owner stands on an issue's asks: no agent asked there, every ask answered (and with what), or the asks still waiting. */
type Standing = { asked: false } | { answer: string } | { waiting: Owed[] };

/**
 * Whether the owner has answered every ask on issue `number` (see `owedOn`),
 * from its comments, each ask on its own: a `Decision:` comment after it
 * that no one but owners edited, a 👍 after its last edit, or a batch answer
 * after it on the Approvals issue (`batch` reads its comments) whose first
 * line names the ask's issue, that no one but owners edited. A proposal for
 * the issue itself, a slice's addition, counts only answers after the issue
 * was last added to a parent, as the work rules count them, so a slice taken
 * out and added again waits on the owner's say again.
 * No agent asked there leaves the label to whoever put it on, such as the
 * weekly job's undo issues.
 */
async function answered(sys: Sys, token: string, slug: string, number: number, { owners, agents, approvals }: Settings, batch: () => Promise<Comment[]>): Promise<Standing> {
  const comments = await every<Comment>(sys, token, `${API}/repos/${slug}/issues/${number}/comments`);
  const owed = owedOn(comments, agents, number);
  if (owed.length === 0) return { asked: false };
  // The issue's own timeline says when it was last added to a parent: read only for a proposal for the issue itself,
  // and none where GitHub cannot find it.
  if (owed.some((one) => one.kind === 'Proposal' && one.number === number)) {
    const timeline = await every<{ event?: string; created_at?: string }>(sys, token, `${API}/repos/${slug}/issues/${number}/timeline`, true);
    const added = timeline.flatMap((event) => (event.event === 'parent_issue_added' && event.created_at ? [event.created_at] : [])).sort().at(-1);
    for (const one of owed) if (added && one.kind === 'Proposal' && one.number === number && added > one.since) one.since = added;
  }
  const earliest = owed.map(({ ask }) => ask.created_at).sort()[0] as string;
  const decisions = comments.filter((comment) => comment.created_at > earliest && anyLogin(owners, comment.user?.login ?? undefined) && opensDecision(comment.body ?? ''));
  // A Decision: someone other than an owner edited answers nothing.
  const decided = decisions.length > 0 ? (await ownersAlone(sys, token, decisions, owners)).kept : [];
  const how = new Map<Owed, string>();
  for (const one of owed) {
    const { ask } = one;
    if (decided.some((decision) => decision.created_at > one.since)) {
      how.set(one, 'a Decision: comment');
      continue;
    }
    const edited = ask.updated_at && ask.updated_at > ask.created_at ? ask.updated_at : ask.created_at;
    const since = edited > one.since ? edited : one.since;
    const reactions = await every<Reaction>(sys, token, `${API}/repos/${slug}/issues/comments/${ask.id}/reactions?content=%2B1`);
    if (reactions.some((reaction) => anyLogin(owners, reaction.user?.login ?? undefined) && reaction.created_at > since)) how.set(one, 'a 👍 on the ask');
  }
  // The Approvals issue is read last, only for asks the issue itself has not answered.
  const open = owed.filter((one) => !how.has(one));
  if (open.length > 0) {
    const answers = await batch();
    const named = open.map((one) => ({ one, batched: batchAnswers(answers, owners, one.number, one.since) }));
    const all = [...new Set(named.flatMap(({ batched }) => batched))];
    const counted = all.length > 0 ? (await ownersAlone(sys, token, all, owners)).kept : [];
    for (const { one, batched } of named) {
      if (batched.some((answer) => counted.includes(answer))) how.set(one, `a "Decision: approve" on #${approvals}, the Approvals issue`);
    }
  }
  const waiting = owed.filter((one) => !how.has(one));
  return waiting.length > 0 ? { waiting } : { answer: [...new Set(how.values())].join(' and ') };
}

/** The asks still waiting, as the sweep names them. */
function waitingOn(waiting: Owed[]): string {
  return waiting.map(({ kind, number }) => (kind === 'Proposal' ? `the proposal for #${number}` : 'the Needs you: ask')).join(', ');
}

/**
 * Judges each open issue labelled `needs-owner` by its asks, and takes the
 * label off where every one is answered. `posted`, the batch answer an
 * event brings, counts though the Approvals issue's list may not show it
 * yet; an issue no agent asked on comes off only when `named`, which that
 * answer names.
 */
async function sweep(sys: Sys, token: string, slug: string, settings: Settings, io: Output, posted?: Comment, named: readonly number[] = []): Promise<void> {
  const waiting = await every<{ number: number }>(sys, token, `${API}/repos/${slug}/issues?state=open&labels=${NEEDS_OWNER}`);
  // The Approvals issue's comments, read once a sweep and only when an issue's own comments have not answered it.
  let approvals: Comment[] | undefined;
  const batch = async (): Promise<Comment[]> => {
    if (settings.approvals === undefined) return [];
    approvals ??= await every<Comment>(sys, token, `${API}/repos/${slug}/issues/${settings.approvals}/comments`, true);
    if (posted && !approvals.some((comment) => comment.id === posted.id)) approvals.push(posted);
    return approvals;
  };
  let cleared = 0;
  for (const { number } of waiting) {
    const standing = await answered(sys, token, slug, number, settings, batch);
    if ('waiting' in standing) {
      io.out(`#${number}: waits on the owner (${waitingOn(standing.waiting)})`);
    } else if ('answer' in standing) {
      await removeLabel(sys, token, slug, number);
      cleared++;
      io.out(`#${number}: the owner answered with ${standing.answer}; ${NEEDS_OWNER} taken off`);
    } else if (named.includes(number)) {
      await removeLabel(sys, token, slug, number);
      cleared++;
      io.out(`#${number}: no agent asked there, and the owner's batch answer names it; ${NEEDS_OWNER} taken off`);
    } else {
      io.out(`#${number}: no agent asked there; left as it is`);
    }
  }
  io.out(`needs-owner: ${waiting.length} labelled ${NEEDS_OWNER}, ${cleared} cleared`);
}

interface Event {
  action?: string;
  comment?: { id?: number; node_id?: string; body?: string | null; user?: { login?: string } | null; created_at?: string; updated_at?: string };
  issue?: { number: number; labels?: { name: string }[] };
  pull_request?: { number: number; labels?: { name: string }[] };
  label?: { name?: string };
  sender?: { login?: string };
}

/**
 * The needs-owner job, run by the shared workflow. An agent's comment that
 * opens with `Needs you:` or `Proposal:` labels its issue `needs-owner`; the
 * owner's `approved` label or `Decision:` comment takes it off at once; the
 * hourly sweep (and a run by hand) takes it off each open issue whose every
 * ask the owner has answered (see `answered`), and so does the owner's
 * comment on the Approvals issue whose first line opens `Decision: approve`,
 * at once, counting itself.
 */
export async function needsOwner(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!name || !eventPath || !slug || !token) {
    throw new Error('needs-owner runs in GitHub Actions: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'needs-owner');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  const settings = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'board')) {
    io.out(offLine('needs-owner', 'board'));
    return 0;
  }
  const event = JSON.parse(sys.read(eventPath)) as Event;
  // A review comment's event names its pull request rather than an issue; GitHub labels both alike.
  const target = event.issue ?? (name === 'pull_request_review_comment' ? event.pull_request : undefined);
  const issue = target?.number;
  const labelled = (target?.labels ?? []).some((label) => label.name === NEEDS_OWNER);
  if ((name === 'issue_comment' || name === 'pull_request_review_comment') && issue !== undefined) {
    const author = event.comment?.user?.login ?? undefined;
    const body = event.comment?.body ?? '';
    if (event.action === 'created' && anyLogin(settings.agents, author) && opensAsk(body)) {
      if (!labelled) await addLabel(sys, token, slug, issue);
      io.out(`needs-owner: #${issue} asks the owner (${opensAsk(body)}:); labelled ${NEEDS_OWNER}`);
      return 0;
    }
    // The owner's batch answer on the Approvals issue names a proposal's own issue, such as a dropped State, not
    // always the issue it waits on, so each labelled issue is judged by its asks, this answer counted.
    const batch = issue === settings.approvals && event.action === 'created' && anyLogin(settings.owners, author) ? approvedIn(body) : [];
    if (batch.length > 0) {
      const { id, node_id, user, created_at, updated_at } = event.comment ?? {};
      const posted = id !== undefined && created_at ? { id, created_at, body, user: user ?? null, ...(node_id ? { node_id } : {}), ...(updated_at ? { updated_at } : {}) } : undefined;
      io.out(`needs-owner: the owner approved ${batch.map((number) => `#${number}`).join(', ')} on #${issue}, the Approvals issue; judging each issue labelled ${NEEDS_OWNER}`);
      await sweep(sys, token, slug, settings, io, posted, batch);
      return 0;
    }
    if (event.action === 'created' && anyLogin(settings.owners, author) && opensDecision(body)) {
      if (labelled) await removeLabel(sys, token, slug, issue);
      io.out(`needs-owner: the owner decided on #${issue}${labelled ? `; ${NEEDS_OWNER} taken off` : ''}`);
      return 0;
    }
    io.out(`needs-owner: the comment on #${issue} neither asks the owner nor is their decision; nothing to do`);
    return 0;
  }
  if (name === 'issues' && issue !== undefined) {
    if (event.action === 'labeled' && event.label?.name === 'approved' && anyLogin(settings.owners, event.sender?.login)) {
      if (labelled) await removeLabel(sys, token, slug, issue);
      io.out(`needs-owner: the owner approved #${issue}${labelled ? `; ${NEEDS_OWNER} taken off` : ''}`);
      return 0;
    }
    io.out(`needs-owner: #${issue} was not approved by the owner; nothing to do`);
    return 0;
  }
  if (name === 'schedule' || name === 'workflow_dispatch') {
    await sweep(sys, token, slug, settings, io);
    return 0;
  }
  io.out(`needs-owner: nothing to do on a ${name} event`);
  return 0;
}
