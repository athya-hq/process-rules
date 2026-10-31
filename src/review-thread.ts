import { API, anyLogin, either, loadSettings, repoAt } from './agent.ts';
import type { Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/** What `review-thread` was asked to do with one review thread. */
export interface ThreadArgs {
  thread: string;
  reply?: string;
  resolve: boolean;
}

/** A review thread's GraphQL id, as GitHub spells them. */
const THREAD_ID = /^PRRT_[A-Za-z0-9_-]+$/;

/** Reads `<thread-id> [--reply <text>] [--resolve]`, refusing anything else. */
export function threadArgs(args: readonly string[]): ThreadArgs {
  const [thread, ...rest] = args;
  if (!thread || !THREAD_ID.test(thread)) throw new Error(`review-thread needs a review thread id (PRRT_…)${thread ? `, not "${thread}"` : ''}`);
  const parsed: ThreadArgs = { thread, resolve: false };
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (option === '--resolve' && !parsed.resolve) parsed.resolve = true;
    else if (option === '--reply' && parsed.reply === undefined && rest[i + 1]?.trim()) parsed.reply = rest[++i] as string;
    else throw new Error(option === '--reply' ? '--reply needs the text of the reply' : `unexpected argument "${option}"`);
  }
  if (parsed.reply === undefined && !parsed.resolve) throw new Error('review-thread needs --reply <text>, --resolve, or both');
  return parsed;
}

async function graphql(sys: Sys, token: string, query: string, variables: Record<string, string>, what: string): Promise<unknown> {
  const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query, variables } });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status !== 200 || !reply?.data || reply.errors?.length) {
    throw new Error(`GitHub refused to ${what} (HTTP ${status}${reply?.errors?.[0]?.message ? `: ${reply.errors[0].message}` : ''})`);
  }
  return reply.data;
}

/**
 * Answers one review thread on a pull request an agent opened in the
 * repository here, as the session's agent: a reply, then resolving it, or either.
 * Only this, so the client's Claude Code settings can allow it without a
 * prompt: answering review findings is routine agent work, like pushing to
 * its branch. Refused unless the session's token is an agent's and the
 * thread is on a pull request any of the agents opened in this repository.
 */
export async function reviewThread(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const { thread, reply, resolve } = threadArgs(args);
  const { root, slug } = repoAt(sys);
  const { agents } = loadSettings(sys, root);
  const agent = either(agents);
  const refused = (problem: string): number => {
    io.err(`✗ ${problem}`);
    io.err('review-thread: refused');
    return 1;
  };
  const token = sessionToken(sys);
  if (!token) return refused('this session has no token; run process-rules doctor');
  const user = await sys.http(`${API}/user`, { token });
  const login = (user.json as { login?: string } | null)?.login;
  if (user.status !== 200 || !anyLogin(agents, login)) return refused(`review-thread answers as ${agent}, but this session's token is ${login ?? 'refused'}`);

  const found = (await graphql(
    sys,
    token,
    'query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { isResolved pullRequest { number author { login } repository { nameWithOwner } } } } }',
    { id: thread },
    `read review thread ${thread}`,
  )) as { node?: { isResolved?: boolean; pullRequest?: { number: number; author: { login: string } | null; repository: { nameWithOwner: string } } } | null };
  const pull = found.node?.pullRequest;
  if (!pull) return refused(`${thread} is not a review thread GitHub shows ${agent}`);
  if (pull.repository.nameWithOwner.toLowerCase() !== slug.toLowerCase()) return refused(`${thread} is on ${pull.repository.nameWithOwner}#${pull.number}, not a pull request in ${slug}`);
  if (!anyLogin(agents, pull.author?.login)) return refused(`${thread} is on #${pull.number}, which ${pull.author?.login ?? 'a deleted account'} opened, not ${agent}`);

  if (reply !== undefined) {
    await graphql(
      sys,
      token,
      'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }',
      { id: thread, body: reply },
      `reply on ${thread}`,
    );
    io.out(`✓ replied on ${thread} (#${pull.number})`);
  }
  if (resolve) {
    if (found.node?.isResolved) {
      io.out(`✓ ${thread} (#${pull.number}) was already resolved`);
    } else {
      await graphql(sys, token, 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }', { id: thread }, `resolve ${thread}`);
      io.out(`✓ resolved ${thread} (#${pull.number})`);
    }
  }
  return 0;
}
