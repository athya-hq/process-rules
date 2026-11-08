import { API, anyLogin } from './agent.ts';
import type { Sys } from './types.ts';

/** A comment as GitHub's REST API gives it: enough to tell whether it was edited, and to look it up in GraphQL. */
export interface Written {
  node_id?: string;
  created_at: string;
  updated_at?: string;
}

/** The owners' comments that count, and why any other did not. */
export interface Kept<T> {
  kept: T[];
  /** Comments someone other than an owner edited, or whose edits GitHub could not show in full. */
  othersEdited: number;
  /** Edited comments whose edits could not be read, since GitHub's GraphQL API did not answer. */
  unread: number;
}

/** Every revision of each comment, the comment as written included, with its editor. */
const QUERY = 'query($ids: [ID!]!) { nodes(ids: $ids) { ... on IssueComment { id userContentEdits(first: 100) { totalCount nodes { editor { login } } } } } }';

interface Node {
  id?: string;
  userContentEdits?: { totalCount: number; nodes: ({ editor: { login: string } | null } | null)[] };
}

/**
 * The owners' comments among `comments` that still say only what owners
 * wrote: unedited (GitHub moves `updated_at` on an edit, not on a reaction),
 * or edited by owners alone. Repo writers, agents included, can edit anyone's
 * comment, and only GitHub's GraphQL `userContentEdits` names who made each
 * edit, so it is read for the edited ones alone: a comment no one edited is
 * judged from REST. An edit whose editor is gone (a deleted account), an
 * edit past the first 100, or a comment GraphQL cannot find makes it not
 * count. Where GraphQL does not answer, as a Claude cloud session's GitHub
 * proxy refuses it, an edited comment does not count.
 */
export async function ownersAlone<T extends Written>(sys: Sys, token: string, comments: T[], owners: string[]): Promise<Kept<T>> {
  const edited = comments.filter((comment) => comment.updated_at !== undefined && comment.updated_at > comment.created_at);
  const ids = [...new Set(edited.flatMap((comment) => (comment.node_id ? [comment.node_id] : [])))];
  const theirs = new Set<string>();
  let answered = true;
  // GitHub looks up at most 100 nodes a request.
  for (let at = 0; at < ids.length; at += 100) {
    const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query: QUERY, variables: { ids: ids.slice(at, at + 100) } } });
    const nodes = (json as { data?: { nodes?: (Node | null)[] } } | null)?.data?.nodes;
    if (status !== 200 || !Array.isArray(nodes)) {
      answered = false;
      break;
    }
    for (const node of nodes) {
      const edits = node?.userContentEdits;
      if (!node?.id || !edits || edits.nodes.length === 0 || edits.totalCount > edits.nodes.length) continue;
      if (edits.nodes.every((edit) => anyLogin(owners, edit?.editor?.login))) theirs.add(node.id);
    }
  }
  const kept: T[] = [];
  let othersEdited = 0;
  let unread = 0;
  for (const comment of comments) {
    if (!edited.includes(comment) || (comment.node_id && theirs.has(comment.node_id))) kept.push(comment);
    else if (answered) othersEdited++;
    else unread++;
  }
  return { kept, othersEdited, unread };
}

/** Why an owner's edited comment, `what`, did not count, for a refusal to say; undefined when none was left out. */
export function whyNotCounted({ othersEdited, unread }: Pick<Kept<unknown>, 'othersEdited' | 'unread'>, what: string): string | undefined {
  if (othersEdited > 0) return `a ${what} someone other than an owner edited does not count`;
  if (unread > 0) return `an edited ${what} counts only once GitHub's GraphQL API shows owners made every edit, and it did not answer here`;
  return undefined;
}
