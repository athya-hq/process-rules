import { API } from './agent.ts';
import type { Sys } from './types.ts';

/** A GraphQL connection's `pageInfo`, as untrusted JSON. */
export interface PageInfo {
  hasNextPage?: unknown;
  endCursor?: unknown;
}

/** One page of a GraphQL connection: its nodes and whether more follow. */
export interface Page<T> {
  nodes?: readonly T[] | null;
  pageInfo?: PageInfo | null;
}

/** Far beyond any real list; a loop past it is a cursor that never moves on. */
export const MAX_PAGES = 1000;

/**
 * The cursor for the next page, or null when the connection says it has no more. Throws when a page does not say
 * whether more follow, claims more without a cursor, or gives back the cursor just fetched: each would end the list
 * early, or never, and a short list must never read as the whole one.
 */
export function nextCursor(after: string | null, pageInfo: PageInfo | null | undefined, what: string): string | null {
  if (typeof pageInfo?.hasNextPage !== 'boolean') throw new Error(`${what}: a page did not say whether more follow, so the list may be short`);
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== 'string' || cursor === '') throw new Error(`${what}: a page says more follow but gives no cursor to read them with`);
  if (cursor === after) throw new Error(`${what}: a page gave back the cursor just read, so the list does not move on`);
  return cursor;
}

/** Every node of a GraphQL connection: `page(null)`, then `page(cursor)` with each page's cursor, to its end. */
export async function connection<T>(what: string, page: (after: string | null) => Promise<Page<T>>, maxPages = MAX_PAGES): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | null = null;
  for (let count = 0; count < maxPages; count++) {
    const one = await page(after);
    nodes.push(...(one.nodes ?? []));
    after = nextCursor(after, one.pageInfo, what);
    if (after === null) return nodes;
  }
  throw new Error(`${what}: more than ${maxPages} pages`);
}

/**
 * Every item of a REST list, 100 to a page until a short one. `under` names the key an object page holds its list
 * under, such as a commit's `check_runs`. Throws on any other answer: an item left out reads as one that is not there.
 */
export async function restList(sys: Sys, token: string, route: string, under?: string, maxPages = MAX_PAGES): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { status, json } = await sys.http(`${API}/${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token });
    const list = under === undefined ? json : (json as Record<string, unknown> | null)?.[under];
    if (status !== 200 || !Array.isArray(list)) throw new Error(`cannot read ${route} (HTTP ${status})`);
    items.push(...list);
    if (list.length < 100) return items;
  }
  throw new Error(`${route}: more than ${maxPages} pages`);
}
