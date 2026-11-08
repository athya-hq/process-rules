import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownersAlone, whyNotCounted } from './edits.ts';
import { FakeSys } from './fake.test.ts';

const OWNER = 'example-owner';
const OWNER_2 = 'Second-Owner';
const AGENT = 'ExampleBot';
const WRITTEN = '2026-11-08T01:00:00Z';
const EDITED = '2026-11-08T02:00:00Z';

type Revisions = (string | null)[];

/** A comment written at WRITTEN, edited at EDITED when `edited`. */
const comment = (node_id: string | undefined, edited = true) => ({ ...(node_id ? { node_id } : {}), created_at: WRITTEN, updated_at: edited ? EDITED : WRITTEN });

/**
 * GitHub's GraphQL API as it answers the edit read: each comment's revisions,
 * newest first, the comment as written last, each naming its editor (null for
 * a deleted account); a comment it has no revisions for reads as null.
 */
function github(revisions: Record<string, Revisions | { totalCount: number; nodes: Revisions }>): FakeSys {
  const sys = new FakeSys();
  sys.route('POST', '/graphql', () => {
    const { ids } = (sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables;
    const nodes = ids.map((id) => {
      const found = revisions[id];
      if (!found) return null;
      const list = Array.isArray(found) ? found : found.nodes;
      return {
        id,
        userContentEdits: {
          totalCount: Array.isArray(found) ? found.length : found.totalCount,
          nodes: list.map((login) => ({ editor: login === null ? null : { login } })),
        },
      };
    });
    return { status: 200, json: { data: { nodes } } };
  });
  return sys;
}

const graphqlCalls = (sys: FakeSys) => sys.requests.filter((request) => request.url.endsWith('/graphql'));

describe('ownersAlone', () => {
  it('keeps an unedited comment without asking GraphQL', async () => {
    const sys = github({});
    const unedited = comment('IC_1', false);
    const noUpdate = { node_id: 'IC_2', created_at: WRITTEN };
    assert.deepEqual(await ownersAlone(sys, 'tok', [unedited, noUpdate], [OWNER]), { kept: [unedited, noUpdate], othersEdited: 0, unread: 0 });
    assert.deepEqual(graphqlCalls(sys), []);
  });

  it('keeps a comment owners alone edited, any of them, and drops one anyone else edited', async () => {
    const sys = github({ IC_1: [OWNER, OWNER], IC_2: [OWNER_2.toLowerCase(), OWNER], IC_3: [AGENT, OWNER], IC_4: [OWNER, AGENT, OWNER] });
    const comments = ['IC_1', 'IC_2', 'IC_3', 'IC_4'].map((id) => comment(id));
    assert.deepEqual(await ownersAlone(sys, 'tok', comments, [OWNER, OWNER_2]), { kept: comments.slice(0, 2), othersEdited: 2, unread: 0 });
    const [call] = graphqlCalls(sys);
    assert.equal(call?.method, 'POST');
    assert.equal(call?.token, 'tok');
    assert.match((call?.body as { query: string }).query, /userContentEdits\(first: 100\) \{ totalCount nodes \{ editor \{ login \} \} \}/);
  });

  it('drops a comment it cannot vouch for: a deleted editor, edits past the first 100, no revisions, no such comment, no GraphQL id', async () => {
    const sys = new FakeSys();
    sys.route('POST', '/graphql', () => ({
      status: 200,
      json: {
        data: {
          nodes: [
            { id: 'IC_1', userContentEdits: { totalCount: 2, nodes: [{ editor: null }, { editor: { login: OWNER } }] } },
            { id: 'IC_2', userContentEdits: { totalCount: 101, nodes: Array.from({ length: 100 }, () => ({ editor: { login: OWNER } })) } },
            { id: 'IC_3' },
            { id: 'IC_4', userContentEdits: { totalCount: 0, nodes: [] } },
            {},
            null,
            { id: 'IC_9', userContentEdits: { totalCount: 1, nodes: [null] } },
          ],
        },
      },
    }));
    const comments = [comment('IC_1'), comment('IC_2'), comment('IC_3'), comment('IC_4'), comment('IC_5'), comment(undefined), comment('IC_9')];
    assert.deepEqual(await ownersAlone(sys, 'tok', comments, [OWNER]), { kept: [], othersEdited: 7, unread: 0 });
  });

  it('reads 100 comments a request', async () => {
    const ids = Array.from({ length: 150 }, (_, n) => `IC_${n}`);
    const sys = github(Object.fromEntries(ids.map((id) => [id, [OWNER]])));
    const comments = ids.map((id) => comment(id));
    assert.equal((await ownersAlone(sys, 'tok', comments, [OWNER])).kept.length, 150);
    assert.deepEqual(
      graphqlCalls(sys).map((call) => (call.body as { variables: { ids: string[] } }).variables.ids.length),
      [100, 50],
    );
  });

  it('counts no edited comment where GraphQL does not answer, as a cloud session proxy refuses it', async () => {
    for (const answer of [{ status: 403, json: { message: 'GraphQL is not available' } }, { status: 200, json: { errors: [{ message: 'x' }] } }, { status: 200, json: null }]) {
      const sys = new FakeSys();
      sys.route('POST', '/graphql', answer);
      const unedited = comment('IC_1', false);
      assert.deepEqual(await ownersAlone(sys, 'tok', [unedited, comment('IC_2'), comment('IC_3')], [OWNER]), { kept: [unedited], othersEdited: 0, unread: 2 });
    }
  });
});

describe('whyNotCounted', () => {
  it('says why an edited comment did not count, or nothing when none was left out', () => {
    assert.equal(whyNotCounted({ othersEdited: 1, unread: 1 }, '"Decision:" comment'), 'a "Decision:" comment someone other than an owner edited does not count');
    assert.equal(
      whyNotCounted({ othersEdited: 0, unread: 1 }, '"Decision:" comment'),
      'an edited "Decision:" comment counts only once GitHub\'s GraphQL API shows owners made every edit, and it did not answer here',
    );
    assert.equal(whyNotCounted({ othersEdited: 0, unread: 0 }, '"Decision:" comment'), undefined);
  });
});
