import { API, repoAt } from './agent.ts';
import { parseDecision } from './decisions.ts';
import type { Output, Sys } from './types.ts';

/** How long the owner has to reverse a routine decision before its `veto` label goes. */
export const VETO_DAYS = 7;
const DAY_MS = 86_400_000;

interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
}

/**
 * The open Decision issues whose review date has come, as JSON lines for the
 * review routine: number, title, link, kind, review date, labels and body.
 * Runs as the agent, in the client's checkout.
 */
export async function reviewsDue(sys: Sys, io: Output): Promise<number> {
  const token = sys.env.GH_TOKEN;
  if (!token) throw new Error('reviews-due needs GH_TOKEN: run it in an agent session');
  const { slug } = repoAt(sys);
  const today = sys.now().toISOString().slice(0, 10);
  let due = 0;
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/issues?state=open&type=Decision&per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list open decisions (HTTP ${status})`);
    for (const issue of json as Issue[]) {
      const decision = parseDecision(issue.body ?? '');
      if (!decision.review || decision.review > today) continue;
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
    if (json.length < 100) break;
  }
  io.err(`reviews-due: ${due} decision${due === 1 ? '' : 's'} due for review on ${today}`);
  return 0;
}

/**
 * Removes `veto` labels the routine added more than a week ago: the owner's
 * window to reverse that decision has closed. Part of the weekly job.
 */
export async function expireVetoes(sys: Sys, io: Output, slug: string, token: string): Promise<void> {
  const { status, json } = await sys.http(`${API}/repos/${slug}/issues?state=all&labels=veto&per_page=100`, { token });
  if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list vetoable decisions (HTTP ${status})`);
  for (const issue of json as Issue[]) {
    const events = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/events?per_page=100`, { token });
    if (events.status !== 200 || !Array.isArray(events.json)) throw new Error(`cannot read #${issue.number}'s events (HTTP ${events.status})`);
    const labeled = (events.json as { event: string; label?: { name: string }; created_at: string }[])
      .filter((event) => event.event === 'labeled' && event.label?.name === 'veto')
      .at(-1);
    if (!labeled || sys.now().getTime() - Date.parse(labeled.created_at) < VETO_DAYS * DAY_MS) continue;
    const removed = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels/veto`, { method: 'DELETE', token });
    if (removed.status !== 200) throw new Error(`cannot remove veto from #${issue.number} (HTTP ${removed.status})`);
    io.out(`#${issue.number}: the week to veto has passed; removed veto`);
  }
}
