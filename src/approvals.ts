import { anyLogin } from './agent.ts';

/**
 * A batch answer's first line: `Decision: approve`, then the issues it
 * approves. Only that line approves; the lines under it are reasons.
 */
const BATCH = /^\s*Decision:\s*approve\b(.*)$/i;
/** An issue of this repository as `#N`, not another's `owner/repo#N` nor an HTML entity such as `&#35;` or `&amp;#35;`. */
const ISSUE = /(?<![\w/.&-])(?<!&\w*;)#(\d+)\b/g;

/** The issues a comment approves as a batch: every `#N` on its first line when that line opens `Decision: approve`; none otherwise. */
export function approvedIn(body: string): number[] {
  const first = BATCH.exec(body.split(/\r?\n/, 1)[0] as string);
  return first ? [...new Set([...(first[1] as string).matchAll(ISSUE)].map((match) => Number(match[1])))] : [];
}

/** A comment on the Approvals issue, as GitHub's REST API gives it. */
export interface Answer {
  body?: string | null;
  user?: { login?: string } | null;
  created_at: string;
}

/**
 * The owners' batch answers among `comments`, the Approvals issue's, that
 * approve issue `number` and were made after `since`: the ask they answer.
 */
export function batchAnswers<T extends Answer>(comments: T[], owners: string[], number: number, since: string): T[] {
  return comments.filter(
    (comment) => anyLogin(owners, comment.user?.login ?? undefined) && comment.created_at > since && approvedIn(comment.body ?? '').includes(number),
  );
}
