import { createHash } from 'node:crypto';

import { API, anyLogin, either, loadSettings, repoAt } from './agent.ts';
import { type Edited, lastEditors, parseDecision } from './decisions.ts';
import { PERSONAL_REPO, isOn, isPersonal, offLine } from './features.ts';
import type { Output, Sys } from './types.ts';

/** How long the owner has to reverse a routine decision before its `veto` label goes. */
export const VETO_DAYS = 7;
/** How long past its review date a decision waits for the routine's verdict before the weekly job labels it `needs-owner`. */
export const OVERDUE_DAYS = 7;
const DAY_MS = 86_400_000;
/** Who writes for the workflow's token: the weekly job. */
export const WORKFLOW_BOT = 'github-actions[bot]';
/** A comment that is the routine's verdict on a decision, when the agent wrote it. */
const VERDICT = /^\s*(?:Kept|Settled):/;

interface Issue {
  number: number;
  node_id: string;
  user: { login: string } | null;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
}

interface Comment {
  id?: number;
  body?: string;
  user?: { login?: string } | null;
  created_at: string;
}

interface Event {
  event: string;
  label?: { name: string };
  actor?: { login?: string } | null;
  created_at: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Labels that mean a decision waits on the owner: the routine leaves it alone. */
const WAITING = ['veto', 'needs-owner'];
/** The mark in the weekly job's comment naming the decision text it vetted, by its SHA-256. */
/** The vetted mark, niyam's or, on decisions vetted before the rename, process-rules'. */
const VETTED = /<!-- (?:niyam|process-rules) vetted sha256:([0-9a-f]{64}) -->/;

/** The SHA-256 of a decision's body, as GitHub returns it, in hex. */
export function textHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The text the weekly job last vetted, as its hash, from the workflow's own comment: only the workflow writes as its bot. */
function vettedHash(comments: Comment[]): { hash: string; id: number | undefined } | undefined {
  const mark = comments.filter((comment) => comment.user?.login === WORKFLOW_BOT && VETTED.test(comment.body ?? '')).at(-1);
  const hash = mark && VETTED.exec(mark.body ?? '')?.[1];
  return hash ? { hash, id: mark.id } : undefined;
}

/**
 * The open Decision issues whose review date has come, as JSON lines for the
 * review routine: number, title, link, kind, review date, labels and body.
 * Only decisions an owner or an agent wrote and last edited, so no one
 * else's text reaches the routine; and none labeled `veto` or `needs-owner`,
 * which wait on the owner. Runs as the agent, in the client's checkout, and
 * reads only GitHub's REST API, as a cloud session's GitHub proxy allows:
 * REST names no body's last editor, so a body counts as theirs only while
 * its hash is the one the weekly job last vetted, in its own comment.
 */
export async function reviewsDue(sys: Sys, io: Output): Promise<number> {
  const { root, slug } = repoAt(sys);
  const { owners, agents } = loadSettings(sys, root);
  if (!isOn(sys, root, 'review')) {
    io.err(offLine('reviews-due', 'review'));
    return 0;
  }
  const token = sys.env.GH_TOKEN;
  if (!token) throw new Error('reviews-due needs GH_TOKEN: run it in an agent session');
  // Decisions are issues of the type Decision.
  if (await isPersonal(sys, slug, token)) {
    io.err(offLine('reviews-due', 'review', PERSONAL_REPO));
    return 0;
  }
  const trusted = (login: string | undefined): boolean => anyLogin(owners, login) || anyLogin(agents, login);
  const today = sys.now().toISOString().slice(0, 10);
  const open: Issue[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/issues?state=open&type=Decision&per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list open decisions (HTTP ${status})`);
    open.push(...(json as Issue[]));
    if (json.length < 100) break;
  }
  let due = 0;
  for (const issue of open) {
    const decision = parseDecision(issue.body ?? '');
    if (!decision.review) continue;
    if (!DATE.test(decision.review) || Number.isNaN(Date.parse(decision.review))) {
      io.err(`#${issue.number}: its Review date "${decision.review}" is not YYYY-MM-DD; fix it so the decision can come up`);
      continue;
    }
    if (decision.review > today) continue;
    if (!trusted(issue.user?.login)) {
      io.err(`#${issue.number}: not reviewed; only ${either([...owners, ...agents])} may write a decision the routine reviews`);
      continue;
    }
    let read: Promise<Comment[]> | undefined;
    const comments = (): Promise<Comment[]> => (read ??= all<Comment>(sys, token, `/repos/${slug}/issues/${issue.number}/comments`, `read #${issue.number}'s comments`));
    const waiting = issue.labels.filter((label) => WAITING.includes(label.name)).map((label) => label.name);
    // A decision the weekly job labeled for want of a verdict still waits on the routine, until the agent has had its say.
    if (waiting.length > 0 && !(waiting.join() === 'needs-owner' && (await overdueUnanswered(sys, token, slug, issue.number, agents, comments)))) continue;
    if (vettedHash(await comments())?.hash !== textHash(issue.body ?? '')) {
      io.err(
        `#${issue.number}: not reviewed; the weekly job has not vetted this text as written and last edited by ${either([...owners, ...agents])}. It vets their edits on its next run`,
      );
      continue;
    }
    due++;
    io.out(
      JSON.stringify({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        kind: decision.kind ?? null,
        review: decision.review,
        labels: issue.labels.map((label) => label.name),
        body: issue.body ?? '',
      }),
    );
  }
  io.err(`reviews-due: ${due} decision${due === 1 ? '' : 's'} due for review on ${today}`);
  return 0;
}

/** Every item a GitHub list gives, page by page. */
async function all<T>(sys: Sys, token: string, path: string, what: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot ${what} (HTTP ${status})`);
    items.push(...(json as T[]));
    if (json.length < 100) return items;
  }
}

/** When `name` was last added to the issue, and by whom. */
async function lastLabeled(sys: Sys, token: string, slug: string, number: number, name: string): Promise<Event | undefined> {
  const events = await all<Event>(sys, token, `/repos/${slug}/issues/${number}/events`, `read #${number}'s events`);
  return events.filter((event) => event.event === 'labeled' && event.label?.name === name).at(-1);
}

/** The agent's comments among an issue's, oldest first: only those can be the routine's. */
function agentComments(comments: Comment[], agents: readonly string[]): Comment[] {
  return comments.filter((comment) => anyLogin(agents, comment.user?.login ?? undefined));
}

/** Whether the weekly job last labeled the issue `needs-owner`, for want of a verdict, and the agent has not commented since. */
async function overdueUnanswered(sys: Sys, token: string, slug: string, number: number, agents: readonly string[], comments: () => Promise<Comment[]>): Promise<boolean> {
  const labeled = await lastLabeled(sys, token, slug, number, 'needs-owner');
  if (labeled?.actor?.login !== WORKFLOW_BOT) return false;
  return !agentComments(await comments(), agents).some((comment) => Date.parse(comment.created_at) >= Date.parse(labeled.created_at));
}

/**
 * Watches the review routine, and vets what it may read. Labels
 * `needs-owner`, with a comment, each open decision the routine reviews whose
 * review date is over a week past with no `Kept:` or `Settled:` from an agent
 * since, so a routine that is missing or has stopped shows up; and takes that
 * label off once an agent's verdict follows it. Only an agent's comments
 * count: anyone may write `Kept:`. For each open decision with a review date
 * that an owner or an agent wrote and last edited, keeps one comment naming
 * its text's SHA-256, which `reviews-due` reads in place of the last editor
 * GitHub's REST API cannot name. Part of the weekly job.
 */
export async function watchReviews(sys: Sys, io: Output, slug: string, token: string, settings: { owners: string[]; agents: string[] }): Promise<void> {
  const { owners, agents } = settings;
  const verdictSince = (comments: Comment[], since: number): boolean =>
    comments.some((comment) => VERDICT.test(comment.body ?? '') && Date.parse(comment.created_at) >= since);
  const read = new Map<number, Promise<Comment[]>>();
  const commentsOf = (number: number): Promise<Comment[]> => {
    let comments = read.get(number);
    if (!comments) {
      comments = all<Comment>(sys, token, `/repos/${slug}/issues/${number}/comments`, `read #${number}'s comments`);
      read.set(number, comments);
    }
    return comments;
  };

  // Taken off first, so this run sees the labels it leaves.
  const flagged = await all<Issue>(sys, token, `/repos/${slug}/issues?state=all&type=Decision&labels=needs-owner`, 'list decisions waiting on the owner');
  const cleared = new Set<number>();
  for (const issue of flagged) {
    const labeled = await lastLabeled(sys, token, slug, issue.number, 'needs-owner');
    // Only the label this job added: the routine's hold and the owner's veto stay.
    if (!labeled || labeled.actor?.login !== WORKFLOW_BOT) continue;
    if (!verdictSince(agentComments(await commentsOf(issue.number), agents), Date.parse(labeled.created_at))) continue;
    const removed = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels/needs-owner`, { method: 'DELETE', token });
    // 404: already off, as when a repeated DELETE follows one whose answer was lost.
    if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot remove needs-owner from #${issue.number} (HTTP ${removed.status})`);
    cleared.add(issue.number);
    io.out(`#${issue.number}: the review routine gave its verdict; removed needs-owner`);
  }

  const today = sys.now().toISOString().slice(0, 10);
  const open = await all<Issue>(sys, token, `/repos/${slug}/issues?state=open&type=Decision`, 'list open decisions');
  const dated = open.filter((issue) => {
    const review = parseDecision(issue.body ?? '').review;
    return review !== undefined && DATE.test(review) && !Number.isNaN(Date.parse(review));
  });
  if (dated.length === 0) return;
  const trusted = (login: string | undefined): boolean => anyLogin(owners, login) || anyLogin(agents, login);
  const editors = await lastEditors(sys, token, dated);
  // reviews-due leaves out the rest, saying why, so the routine is neither shown them nor late on them.
  const theirs = dated.filter((issue) => {
    const edited = editors.get(issue.number);
    return edited !== undefined && trusted(issue.user?.login) && (edited.editor === undefined || trusted(edited.editor));
  });

  // The body GitHub gave with its editor, not the listing's, so an edit between the two reads is not vetted as theirs.
  for (const issue of theirs) {
    const hash = textHash((editors.get(issue.number) as Edited).body);
    const mark = vettedHash(await commentsOf(issue.number));
    if (mark?.hash === hash) continue;
    const body = {
      body: `Vetted for the review routine on ${today}: ${either([...owners, ...agents])} wrote and last edited this decision's text, so \`reviews-due\` lists it while its text is this one. This job vets it again after their next edit.\n\n<!-- niyam vetted sha256:${hash} -->`,
    };
    if (mark?.id !== undefined) {
      const edited = await sys.http(`${API}/repos/${slug}/issues/comments/${mark.id}`, { method: 'PATCH', token, body });
      if (edited.status !== 200) throw new Error(`cannot update #${issue.number}'s vetted comment (HTTP ${edited.status})`);
    } else {
      const commented = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/comments`, { method: 'POST', token, body });
      if (commented.status !== 201) throw new Error(`cannot comment on #${issue.number} (HTTP ${commented.status})`);
    }
    io.out(`#${issue.number}: vetted its text for the review routine`);
  }

  // Its review date from that same body, so an edit moving the date since the listing counts.
  const reviewOf = (issue: Issue): string | undefined => {
    const review = parseDecision((editors.get(issue.number) as Edited).body).review;
    return review !== undefined && DATE.test(review) && !Number.isNaN(Date.parse(review)) ? review : undefined;
  };
  const overdue = theirs.filter((issue) => {
    if (issue.labels.some((label) => WAITING.includes(label.name)) && !cleared.has(issue.number)) return false;
    const review = reviewOf(issue);
    return review !== undefined && (Date.parse(today) - Date.parse(review)) / DAY_MS > OVERDUE_DAYS;
  });
  for (const issue of overdue) {
    const review = reviewOf(issue) as string;
    if (verdictSince(agentComments(await commentsOf(issue.number), agents), Date.parse(review))) continue;
    const added = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels`, { method: 'POST', token, body: { labels: ['needs-owner'] } });
    if (added.status !== 200) throw new Error(`cannot label #${issue.number} needs-owner (HTTP ${added.status})`);
    const commented = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/comments`, {
      method: 'POST',
      token,
      body: {
        body: `Review overdue: its review date, ${review}, is over a week past, and ${either(agents)} has written no \`Kept:\` or \`Settled:\` on it since. Check that the review routine exists and runs as ${either(agents)}. This label goes once its verdict comes.`,
      },
    });
    if (commented.status !== 201) throw new Error(`cannot comment on #${issue.number} (HTTP ${commented.status})`);
    io.out(`#${issue.number}: its review, ${review}, is over a week past with no verdict from the agent; labeled needs-owner`);
  }
}

/**
 * Removes `veto` labels the routine added more than a week ago: the owner's
 * window to reverse that decision has closed. Part of the weekly job.
 */
export async function expireVetoes(sys: Sys, io: Output, slug: string, token: string): Promise<void> {
  const vetoed = await all<Issue>(sys, token, `/repos/${slug}/issues?state=all&type=Decision&labels=veto`, 'list vetoable decisions');
  for (const issue of vetoed) {
    const labeled = await lastLabeled(sys, token, slug, issue.number, 'veto');
    if (!labeled || sys.now().getTime() - Date.parse(labeled.created_at) < VETO_DAYS * DAY_MS) continue;
    const removed = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels/veto`, { method: 'DELETE', token });
    // 404: already off, as when a repeated DELETE follows one whose answer was lost.
    if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot remove veto from #${issue.number} (HTTP ${removed.status})`);
    io.out(`#${issue.number}: the week to veto has passed; removed veto`);
  }
}
