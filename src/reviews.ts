import { API, loadSettings, repoAt, sameLogin } from './agent.ts';
import { lastEditors, parseDecision } from './decisions.ts';
import type { Output, Sys } from './types.ts';

/** How long the owner has to reverse a routine decision before its `veto` label goes. */
export const VETO_DAYS = 7;
const DAY_MS = 86_400_000;

interface Issue {
  number: number;
  node_id: string;
  user: { login: string } | null;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Labels that mean a decision waits on the owner: the routine leaves it alone. */
const WAITING = ['veto', 'needs-owner'];

/**
 * The open Decision issues whose review date has come, as JSON lines for the
 * review routine: number, title, link, kind, review date, labels and body.
 * Only decisions the owner or the agent wrote and last edited, so no one
 * else's text reaches the routine; and none labeled `veto` or `needs-owner`,
 * which wait on the owner. Runs as the agent, in the client's checkout.
 */
export async function reviewsDue(sys: Sys, io: Output): Promise<number> {
  const token = sys.env.GH_TOKEN;
  if (!token) throw new Error('reviews-due needs GH_TOKEN: run it in an agent session');
  const { root, slug } = repoAt(sys);
  const { owner, agent } = loadSettings(sys, root);
  const trusted = (login: string | undefined): boolean => sameLogin(login, owner) || sameLogin(login, agent);
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
      io.err(`#${issue.number}: not reviewed; only ${owner} or ${agent} may write a decision the routine reviews`);
      continue;
    }
    if (issue.labels.some((label) => WAITING.includes(label.name))) continue;
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

/**
 * Removes `veto` labels the routine added more than a week ago: the owner's
 * window to reverse that decision has closed. Part of the weekly job.
 */
export async function expireVetoes(sys: Sys, io: Output, slug: string, token: string): Promise<void> {
  const vetoed: Issue[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/issues?state=all&labels=veto&per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list vetoable decisions (HTTP ${status})`);
    vetoed.push(...(json as Issue[]));
    if (json.length < 100) break;
  }
  for (const issue of vetoed) {
    const events: { event: string; label?: { name: string }; created_at: string }[] = [];
    for (let page = 1; ; page++) {
      const reply = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/events?per_page=100&page=${page}`, { token });
      if (reply.status !== 200 || !Array.isArray(reply.json)) throw new Error(`cannot read #${issue.number}'s events (HTTP ${reply.status})`);
      events.push(...(reply.json as typeof events));
      if (reply.json.length < 100) break;
    }
    const labeled = events.filter((event) => event.event === 'labeled' && event.label?.name === 'veto').at(-1);
    if (!labeled || sys.now().getTime() - Date.parse(labeled.created_at) < VETO_DAYS * DAY_MS) continue;
    const removed = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels/veto`, { method: 'DELETE', token });
    if (removed.status !== 200) throw new Error(`cannot remove veto from #${issue.number} (HTTP ${removed.status})`);
    io.out(`#${issue.number}: the week to veto has passed; removed veto`);
  }
}
