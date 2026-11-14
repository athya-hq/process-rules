import { resolve as resolvePath } from 'node:path';

import { API, anyLogin, either, loadSettings, repoAt } from './agent.ts';
import { connection, type Page } from './pages.ts';
import { proxyThreads, restComments } from './pr-signals.ts';
import type { Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/** What `review-thread` was asked to do with one review thread. */
export interface ThreadArgs {
  thread: string;
  /** The reply's text, given inline. */
  reply?: string;
  /** A file holding the reply's text: replies hold backticks and braces a shell guard may refuse in an argument. */
  bodyFile?: string;
  resolve: boolean;
  reaction?: '+1' | '-1';
  /** The comment the reaction goes on: one of the thread's. */
  comment?: string;
}

/** A review thread's GraphQL id, as GitHub spells them. */
const THREAD_ID = /^PRRT_[A-Za-z0-9_-]+$/;
/** A REST id: in a Claude cloud session a thread is named by its first comment's. */
const REST_ID = /^[1-9]\d*$/;
/** A comment's GraphQL id. */
const COMMENT_ID = /^[A-Za-z_]+_[A-Za-z0-9_-]+$/;

const REACTIONS = { '+1': 'THUMBS_UP', '-1': 'THUMBS_DOWN' } as const;

/**
 * Reads `<thread-id> [--reply <text> | --body-file <path>] [--resolve | --no-resolve] [--reaction <+1|-1> --comment-id <id>]`,
 * refusing anything else. A reply from --body-file resolves the thread unless --no-resolve says not to; an inline
 * --reply resolves only with --resolve, as before.
 */
export function threadArgs(args: readonly string[]): ThreadArgs {
  const [thread, ...rest] = args;
  if (!thread || !(THREAD_ID.test(thread) || REST_ID.test(thread))) {
    throw new Error(`review-thread needs a review thread id (PRRT_…, or in a Claude cloud session its first comment's number)${thread ? `, not "${thread}"` : ''}`);
  }
  const given = new Map<string, string | true>();
  const VALUES = new Set(['--reply', '--body-file', '--reaction', '--comment-id']);
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i] as string;
    if (given.has(option) || !(VALUES.has(option) || option === '--resolve' || option === '--no-resolve')) throw new Error(`unexpected argument "${option}"`);
    if (!VALUES.has(option)) {
      given.set(option, true);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error(option === '--reply' ? '--reply needs the text of the reply' : `${option} needs a value`);
    given.set(option, value);
    i++;
  }
  const value = (name: string): string | undefined => given.get(name) as string | undefined;
  const reply = value('--reply');
  const bodyFile = value('--body-file');
  const reaction = value('--reaction');
  const comment = value('--comment-id');
  if (reply !== undefined && bodyFile !== undefined) throw new Error('review-thread takes --reply or --body-file, not both');
  if (given.has('--resolve') && given.has('--no-resolve')) throw new Error('review-thread takes --resolve or --no-resolve, not both');
  if (given.has('--no-resolve') && bodyFile === undefined) throw new Error('--no-resolve goes with --body-file, whose reply resolves the thread unless told not to');
  if (reaction !== undefined && !Object.hasOwn(REACTIONS, reaction)) throw new Error(`--reaction takes +1 or -1, not "${reaction}"`);
  if ((reaction === undefined) !== (comment === undefined)) throw new Error('--reaction and --comment-id go together: a reaction goes on a comment, not on a thread');
  const resolve = given.has('--resolve') || (bodyFile !== undefined && !given.has('--no-resolve'));
  if (reply === undefined && bodyFile === undefined && !resolve && reaction === undefined) throw new Error('review-thread needs --reply <text>, --body-file <path>, --resolve, or --reaction');
  return {
    thread,
    ...(reply === undefined ? {} : { reply }),
    ...(bodyFile === undefined ? {} : { bodyFile }),
    resolve,
    ...(reaction === undefined ? {} : { reaction: reaction as '+1' | '-1', comment: comment as string }),
  };
}

/** Why the ids cannot be used where this session reaches GitHub, or undefined: each transport names a thread its own way. */
export function idProblem(cloud: boolean, thread: string, comment?: string): string | undefined {
  if (cloud) {
    if (!REST_ID.test(thread)) return `in a Claude cloud session a thread is named by its first comment's number (the one in its #discussion_r link, or the thread pr-signals prints there), not ${thread}`;
    if (comment !== undefined && !REST_ID.test(comment)) return `in a Claude cloud session --comment-id takes a comment's number, not ${comment}`;
    return undefined;
  }
  if (!THREAD_ID.test(thread)) return `on this machine a thread is named by its node id (PRRT_…), as pr-signals prints it, not the number ${thread}`;
  if (comment !== undefined && (REST_ID.test(comment) || THREAD_ID.test(comment) || !COMMENT_ID.test(comment))) return `on this machine --comment-id takes a comment's node id, as pr-signals prints it, not ${comment}`;
  return undefined;
}

/**
 * The footer a Claude cloud session's proxy appends to what it posts; a reply is compared without it, so a rerun
 * there never posts it twice.
 */
const FOOTER = /\n+---\n_Generated by \[Claude Code\]\(https:\/\/claude\.ai\/code(?:\/[^)\s]*)?\)_\s*$/;

/** A posted body as its author wrote it. */
export function withoutFooter(body: string): string {
  return body.replace(FOOTER, '');
}

async function graphql(sys: Sys, token: string, query: string, variables: Record<string, string>, what: string): Promise<unknown> {
  const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query, variables } });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status !== 200 || !reply?.data || reply.errors?.length) {
    throw new Error(`GitHub refused to ${what} (HTTP ${status}${reply?.errors?.[0]?.message ? `: ${reply.errors[0].message}` : ''})`);
  }
  return reply.data;
}

/** The thread as both transports give it. */
interface Found {
  pull: number;
  author: string | undefined;
  repository: string;
  resolved: boolean;
  /** The thread's comments, by the id --comment-id takes, with their bodies. */
  comments: { id: string; body: string }[];
}

/** One thread's transport: GraphQL on a machine, the proxy's REST routes in a Claude cloud session. */
interface Transport {
  find(): Promise<Found | string>;
  reply(found: Found, body: string): Promise<void>;
  react(found: Found, comment: string, reaction: '+1' | '-1'): Promise<void>;
  resolve(found: Found): Promise<void>;
}

const THREAD_QUERY =
  'query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { isResolved pullRequest { number author { login } repository { nameWithOwner } } comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id body } } } } }';

interface ThreadNode {
  isResolved?: boolean;
  pullRequest?: { number: number; author: { login: string } | null; repository: { nameWithOwner: string } };
  comments?: Page<{ id: string; body: string }>;
}

function graphTransport(sys: Sys, token: string, thread: string, agent: string): Transport {
  return {
    async find() {
      let node: ThreadNode | null | undefined;
      const comments = await connection<{ id: string; body: string }>(`the comments of ${thread}`, async (after) => {
        const data = (await graphql(sys, token, THREAD_QUERY, { id: thread, ...(after === null ? {} : { after }) }, `read review thread ${thread}`)) as { node?: ThreadNode | null };
        node = data.node;
        return node?.pullRequest ? (node.comments ?? { nodes: [], pageInfo: { hasNextPage: false } }) : { nodes: [], pageInfo: { hasNextPage: false } };
      });
      const pull = (node as ThreadNode | null | undefined)?.pullRequest;
      if (!pull) return `${thread} is not a review thread GitHub shows ${agent}`;
      return { pull: pull.number, author: pull.author?.login, repository: pull.repository.nameWithOwner, resolved: node?.isResolved === true, comments };
    },
    async reply(_found, body) {
      await graphql(sys, token, 'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }', { id: thread, body }, `reply on ${thread}`);
    },
    async react(_found, comment, reaction) {
      await graphql(sys, token, 'mutation($id: ID!, $content: ReactionContent!) { addReaction(input: { subjectId: $id, content: $content }) { reaction { content } } }', { id: comment, content: REACTIONS[reaction] }, `react on ${comment}`);
    },
    async resolve() {
      await graphql(sys, token, 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }', { id: thread }, `resolve ${thread}`);
    },
  };
}

/** The pull request a REST pull-request URL names, as owner/repo and number. */
const PULL_URL = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/;

function cloudTransport(sys: Sys, token: string, slug: string, thread: string): Transport {
  const post = async (route: string, body: unknown, what: string): Promise<unknown> => {
    const { status, json } = await sys.http(`${API}/${route}`, { method: 'POST', token, ...(body === undefined ? {} : { body }) });
    if (status !== 200 && status !== 201) throw new Error(`GitHub refused to ${what} (HTTP ${status})`);
    return json;
  };
  return {
    async find() {
      const first = await sys.http(`${API}/repos/${slug}/pulls/comments/${thread}`, { token });
      const comment = first.json as { pull_request_url?: unknown; in_reply_to_id?: unknown } | null;
      if (first.status === 404) return `${thread} is not a review comment in ${slug}`;
      if (first.status !== 200 || typeof comment?.pull_request_url !== 'string') throw new Error(`cannot read review comment ${thread} (HTTP ${first.status})`);
      if (comment.in_reply_to_id != null) return `${thread} is a reply, not the first comment of its thread; name the thread by its first comment, as pr-signals prints it`;
      const [, repository = '', number = ''] = PULL_URL.exec(comment.pull_request_url) ?? [];
      const pullNumber = Number(number);
      const pull = await sys.http(`${API}/repos/${repository}/pulls/${pullNumber}`, { token });
      const author = (pull.json as { user?: { login?: unknown } | null } | null)?.user?.login;
      if (pull.status !== 200) throw new Error(`cannot read pull request #${pullNumber} (HTTP ${pull.status})`);
      const id = Number(thread);
      const comments = (await restComments(sys, token, repository, pullNumber)).filter((c) => c.id === id || c.inReplyTo === id).map((c) => ({ id: String(c.id), body: c.body }));
      const listed = (await proxyThreads(sys, token, repository, pullNumber)).find((t) => t.comments[0] === id);
      return { pull: pullNumber, author: typeof author === 'string' ? author : undefined, repository, resolved: listed?.resolved === true, comments };
    },
    async reply(found, body) {
      await post(`repos/${slug}/pulls/${found.pull}/comments/${thread}/replies`, { body }, `reply on ${thread}`);
    },
    async react(_found, comment, reaction) {
      await post(`repos/${slug}/pulls/comments/${comment}/reactions`, { content: reaction }, `react on ${comment}`);
    },
    async resolve(found) {
      const answer = (await post(`repos/${slug}/pulls/${found.pull}/ccr/comments/${thread}/resolve`, undefined, `resolve ${thread}`)) as { resolved?: unknown } | null;
      if (answer?.resolved !== true) throw new Error(`GitHub's proxy did not resolve ${thread}`);
    },
  };
}

/**
 * Answers one review thread on a pull request an agent opened in the repository here, as the session's agent: a
 * reply, a reaction on one of its comments, resolving it, or any of them. Only this, so the client's Claude Code
 * settings can allow it without a prompt: answering review findings is routine agent work, like pushing to its
 * branch. Refused unless the session's token is an agent's and the thread is on a pull request any of the agents
 * opened in this repository. A reply already on the thread is not posted again, so a rerun is safe. In a Claude
 * cloud session, whose proxy refuses GraphQL, it uses the proxy's REST routes.
 */
export async function reviewThread(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const { thread, reply, bodyFile, resolve, reaction, comment } = threadArgs(args);
  const { root, slug } = repoAt(sys);
  const { agents } = loadSettings(sys, root);
  const agent = either(agents);
  const refused = (problem: string): number => {
    io.err(`✗ ${problem}`);
    io.err('review-thread: refused');
    return 1;
  };
  const cloud = sys.env.CLAUDE_CODE_REMOTE === 'true';
  const wrongId = idProblem(cloud, thread, comment);
  if (wrongId) return refused(wrongId);
  let body = reply;
  if (bodyFile !== undefined) {
    // Only a file in the repository: an allow rule runs this without a prompt, so it must not post a file from elsewhere.
    const path = resolvePath(sys.cwd, bodyFile);
    if (!path.startsWith(`${root}/`)) return refused(`${bodyFile} is outside the repository at ${root}; write the reply in it, such as in .tmp/`);
    if (!sys.exists(path)) return refused(`${bodyFile} is not there`);
    body = sys.read(path).trim();
    if (!body) return refused(`${bodyFile} is empty: there is no reply in it`);
  }
  const token = sessionToken(sys);
  if (!token) return refused('this session has no token; run niyam doctor');
  const user = await sys.http(`${API}/user`, { token });
  const login = (user.json as { login?: string } | null)?.login;
  if (user.status !== 200 || !anyLogin(agents, login)) return refused(`review-thread answers as ${agent}, but this session's token is ${login ?? 'refused'}`);

  const transport = cloud ? cloudTransport(sys, token, slug, thread) : graphTransport(sys, token, thread, agent);
  const found = await transport.find();
  if (typeof found === 'string') return refused(found);
  if (found.repository.toLowerCase() !== slug.toLowerCase()) return refused(`${thread} is on ${found.repository}#${found.pull}, not a pull request in ${slug}`);
  if (!anyLogin(agents, found.author)) return refused(`${thread} is on #${found.pull}, which ${found.author ?? 'a deleted account'} opened, not ${agent}`);
  if (comment !== undefined && !found.comments.some((one) => one.id === comment)) return refused(`${comment} is not a comment of ${thread}`);

  if (body !== undefined) {
    const wanted = body.trim();
    if (found.comments.some((one) => withoutFooter(one.body).trim() === wanted)) {
      io.out(`✓ ${thread} (#${found.pull}) has this reply already`);
    } else {
      await transport.reply(found, body);
      io.out(`✓ replied on ${thread} (#${found.pull})`);
    }
  }
  if (reaction !== undefined && comment !== undefined) {
    // A reaction that fails never keeps the thread from being resolved: an open thread holds the merge, a missing emoji does not.
    try {
      await transport.react(found, comment, reaction);
      io.out(`✓ reacted ${reaction} on ${comment}`);
    } catch (error) {
      io.err(`⚠ the ${reaction} on ${comment} failed (${error instanceof Error ? error.message : String(error)}); going on`);
    }
  }
  if (resolve) {
    if (found.resolved) {
      io.out(`✓ ${thread} (#${found.pull}) was already resolved`);
    } else {
      await transport.resolve(found);
      io.out(`✓ resolved ${thread} (#${found.pull})`);
    }
  }
  return 0;
}
