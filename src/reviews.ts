import { API, anyLogin, either, loadSettings, repoAt } from './agent.ts';
import { lastEditors, parseDecision } from './decisions.ts';
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

/**
 * The open Decision issues whose review date has come, as JSON lines for the
 * review routine: number, title, link, kind, review date, labels and body.
 * Only decisions an owner or an agent wrote and last edited, so no one
 * else's text reaches the routine; and none labeled `veto` or `needs-owner`,
 * which wait on the owner. Runs as the agent, in the client's checkout.
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
  const editors = await lastEditors(sys, token, open);
  let due = 0;
  for (const issue of open) {
    const decision = parseDecision(issue.body ?? '');
    if (!decision.review) continue;
    if (!DATE.test(decision.review) || Number.isNaN(Date.parse(decision.review))) {
      io.err(`#${issue.number}: its Review date "${decision.review}" is not YYYY-MM-DD; fix it so the decision can come up`);
      continue;
    }
    if (decision.review > today) continue;
    const editor = editors.get(issue.number);
    if (!trusted(issue.user?.login) || (editor !== undefined && !trusted(editor))) {
      io.err(`#${issue.number}: not reviewed; only ${either([...owners, ...agents])} may write a decision the routine reviews`);
      continue;
    }
    const waiting = issue.labels.filter((label) => WAITING.includes(label.name)).map((label) => label.name);
    // A decision the weekly job labeled for want of a verdict still waits on the routine, until the agent has had its say.
    if (waiting.length > 0 && !(waiting.join() === 'needs-owner' && (await overdueUnanswered(sys, token, slug, issue.number, agents)))) continue;
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

/** The agent's comments on the issue, oldest first: only those can be the routine's. */
async function agentComments(sys: Sys, token: string, slug: string, number: number, agents: readonly string[]): Promise<Comment[]> {
  const comments = await all<Comment>(sys, token, `/repos/${slug}/issues/${number}/comments`, `read #${number}'s comments`);
  return comments.filter((comment) => anyLogin(agents, comment.user?.login ?? undefined));
}

/** Whether the weekly job last labeled the issue `needs-owner`, for want of a verdict, and the agent has not commented since. */
async function overdueUnanswered(sys: Sys, token: string, slug: string, number: number, agents: readonly string[]): Promise<boolean> {
  const labeled = await lastLabeled(sys, token, slug, number, 'needs-owner');
  if (labeled?.actor?.login !== WORKFLOW_BOT) return false;
  const comments = await agentComments(sys, token, slug, number, agents);
  return !comments.some((comment) => Date.parse(comment.created_at) >= Date.parse(labeled.created_at));
}

/**
 * Watches the review routine. Labels `needs-owner`, with a comment, each open
 * decision the routine reviews whose review date is over a week past with no
 * `Kept:` or `Settled:` from an agent since, so a routine that is missing or
 * has stopped shows up; and takes that label off once an agent's verdict
 * follows it. Only an agent's comments count: anyone may write `Kept:`.
 * Part of the weekly job.
 */
export async function watchReviews(sys: Sys, io: Output, slug: string, token: string, settings: { owners: string[]; agents: string[] }): Promise<void> {
  const { owners, agents } = settings;
  const verdictSince = (comments: Comment[], since: number): boolean =>
    comments.some((comment) => VERDICT.test(comment.body ?? '') && Date.parse(comment.created_at) >= since);

  // Taken off first, so this run sees the labels it leaves.
  const flagged = await all<Issue>(sys, token, `/repos/${slug}/issues?state=all&type=Decision&labels=needs-owner`, 'list decisions waiting on the owner');
  const cleared = new Set<number>();
  for (const issue of flagged) {
    const labeled = await lastLabeled(sys, token, slug, issue.number, 'needs-owner');
    // Only the label this job added: the routine's hold and the owner's veto stay.
    if (!labeled || labeled.actor?.login !== WORKFLOW_BOT) continue;
    if (!verdictSince(await agentComments(sys, token, slug, issue.number, agents), Date.parse(labeled.created_at))) continue;
    const removed = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels/needs-owner`, { method: 'DELETE', token });
    if (removed.status !== 200) throw new Error(`cannot remove needs-owner from #${issue.number} (HTTP ${removed.status})`);
    cleared.add(issue.number);
    io.out(`#${issue.number}: the review routine gave its verdict; removed needs-owner`);
  }

  const today = Date.parse(sys.now().toISOString().slice(0, 10));
  const open = await all<Issue>(sys, token, `/repos/${slug}/issues?state=open&type=Decision`, 'list open decisions');
  const overdue = open.filter((issue) => {
    const review = parseDecision(issue.body ?? '').review;
    if (!review || !DATE.test(review) || Number.isNaN(Date.parse(review))) return false;
    if (issue.labels.some((label) => WAITING.includes(label.name)) && !cleared.has(issue.number)) return false;
    return (today - Date.parse(review)) / DAY_MS > OVERDUE_DAYS;
  });
  if (overdue.length === 0) return;
  const trusted = (login: string | undefined): boolean => anyLogin(owners, login) || anyLogin(agents, login);
  const editors = await lastEditors(sys, token, overdue);
  for (const issue of overdue) {
    const editor = editors.get(issue.number);
    // reviews-due leaves these out, saying why, so the routine is not late on them.
    if (!trusted(issue.user?.login) || (editor !== undefined && !trusted(editor))) continue;
    const review = parseDecision(issue.body ?? '').review as string;
    if (verdictSince(await agentComments(sys, token, slug, issue.number, agents), Date.parse(review))) continue;
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
    if (removed.status !== 200) throw new Error(`cannot remove veto from #${issue.number} (HTTP ${removed.status})`);
    io.out(`#${issue.number}: the week to veto has passed; removed veto`);
  }
}
