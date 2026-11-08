import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Settings } from './agent.ts';
import { RestBoard } from './fake-board.test.ts';
import { AGENT, FakeSys, ROOT, SETTINGS, capture } from './fake.test.ts';
import { prMerged, prePush, prWorkRules, propose, section, sliceProblems, slicesNamed } from './work.ts';

const SLUG = 'example-org/example-app';
const OWNER = 'example-owner';
const ACCOUNTS = { owners: [OWNER], agents: [AGENT] };
const T0 = '2026-10-01T00:00:00Z';
const APPROVED = '2026-10-02T00:00:00Z';
const LATER = '2026-10-03T00:00:00Z';
const LATEST = '2026-10-04T00:00:00Z';

type Node = Record<string, unknown>;

/** The Approvals issue, as settings that name one name it. */
const APPROVALS = 700;
const WITH_APPROVALS = { ...ACCOUNTS, approvals: APPROVALS };

/** Slice #12 under work item #10, approved by the owner, with nothing else; the Approvals issue, #700, with no comments. */
function graph(): {
  issue: Node;
  timeline: Node[];
  own: Node[];
  siblings: Node[];
  states: Node[];
  comments: Node[];
  thumbs: Map<string, Node[]>;
  approvals: Node[];
} {
  const timeline: Node[] = [
    { event: 'sub_issue_added', created_at: T0, sub_issue: { number: 12 } },
    { event: 'labeled', created_at: APPROVED, actor: { login: OWNER }, label: { name: 'approved' } },
  ];
  // The slice's own timeline: when it was put under its work item, as GITHUB_TOKEN reads it, naming no parent.
  const own: Node[] = [{ event: 'parent_issue_added', created_at: T0, parent_issue: null }];
  // The work item's other sub-issues, each with its own timeline.
  const siblings: Node[] = [];
  const states: Node[] = [];
  const comments: Node[] = [];
  const approvals: Node[] = [];
  const issue: Node = {
    number: 12,
    title: 'Add the thing',
    body: 'Slice P-01 of #10.\n\n**You will see:** the thing.\n- on every page\n\n**Why:** it is asked for.\n\n**Needs:** —',
    state: 'open',
    type: { name: 'Slice' },
    comments,
    parent: { number: 10, type: { name: 'Work item' } },
    timeline,
    own,
    siblings,
    states,
    thumbs: new Map<string, Node[]>(),
    approvals,
  };
  return { issue, timeline, own, siblings, states, comments, thumbs: issue.thumbs as Map<string, Node[]>, approvals };
}

const ISSUES = `https://api.github.com/repos/${SLUG}/issues`;
const LIST = /^(.*?)[?&]per_page=100&page=(\d+)$/;

/** What GitHub's REST API answers `url` with for slice `issue`'s model, or undefined for a path it does not hold. */
function answer(issue: Node | null, url: string): { status: number; json: unknown } | undefined {
  const list = LIST.exec(url);
  const path = (list ? list[1] as string : url).replace(ISSUES, '');
  const page = (items: Node[] | undefined): { status: number; json: unknown } | undefined => {
    if (!items) return undefined;
    const from = (Number(list?.[2]) - 1) * 100;
    return { status: 200, json: items.slice(from, from + 100) };
  };
  if (!issue) return undefined;
  if (path === `/${APPROVALS}/comments`) return page(issue.approvals as Node[]);
  const parent = issue.parent as Node | null;
  const states = (issue.states as Node[]).map((state): Node => ({ ...state, url: `${ISSUES}/${state.number}` }));
  // As a workflow's GITHUB_TOKEN reads a private repository: no parent_issue_url, the parent from its endpoint alone.
  if (path === '/12') return { status: 200, json: { ...issue, url: `${ISSUES}/12`, parent_issue_url: null } };
  if (path === '/12/parent') {
    return parent ? { status: 200, json: { ...parent, url: `${ISSUES}/10` } } : { status: 404, json: { message: 'No parent issue found' } };
  }
  if (path === '/10/timeline') return page(issue.timeline as Node[]);
  if (path === '/12/timeline') return page(issue.own as Node[]);
  const siblings = (issue.siblings as Node[] | undefined) ?? [];
  if (path === '/10/sub_issues') return page([{ ...issue, url: `${ISSUES}/12` }, ...siblings.map((one) => ({ ...one, url: `${ISSUES}/${one.number}` }))]);
  const sibling = siblings.find((one) => path === `/${one.number}/timeline`);
  if (sibling) return page(sibling.own as Node[]);
  if (path === '/12/comments') return page(issue.comments as Node[]);
  if (path === '/12/sub_issues') return page(states);
  const own = /^\/(\d+)(\/comments|\/parent)?$/.exec(path);
  const state = states.find((one) => one.number === Number(own?.[1]));
  if (state && own?.[2] === '/parent') return { status: 200, json: { ...issue, url: `${ISSUES}/12` } };
  if (state) return own?.[2] ? page(state.comments as Node[]) : { status: 200, json: state };
  const reactions = /^\/comments\/([^/]+)\/reactions\?content=%2B1$/.exec(path);
  // A deleted comment reads as 404.
  if (reactions && reactions[1] !== 'gone') return page((issue.thumbs as Map<string, Node[]>).get(reactions[1] as string) ?? []);
  return undefined;
}

/** GitHub as slice `issue`'s model says, read when asked so a test can change it after; routes a test sets win. */
function github(sys: FakeSys, issue: Node | null, pulls: Node[] = []): void {
  const http = sys.http.bind(sys);
  sys.http = (url, options = {}) => {
    const key = `${options.method ?? 'GET'} ${url}`;
    if (!sys.routes.has(key) && (options.method ?? 'GET') === 'GET' && url.startsWith(ISSUES)) {
      sys.route('GET', url, () => answer(issue, url) ?? { status: 404, json: { message: 'Not Found' } });
    }
    return http(url, options);
  };
  sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=1`, { status: 200, json: pulls });
  // No open Work items and no Projects, so a push moves nothing on the board.
  sys.route('GET', `${ISSUES}?state=open&type=Work%20item&sort=created&direction=desc&per_page=100`, { status: 200, json: [] });
  sys.route('GET', '/orgs/example-org/projectsV2?per_page=100', { status: 200, json: [] });
}

let ids = 0;
const comment = (body: string, created_at = LATEST, login = OWNER, edited: string | null = null): Node => ({
  event: 'commented',
  id: `IC_${++ids}`,
  node_id: `IC_${ids}`,
  user: { login },
  body,
  created_at,
  updated_at: edited ?? created_at,
  // Where the owner acts on it; the propose tests' proposals are on slice #12.
  html_url: `https://github.com/${SLUG}/issues/12#issuecomment-${ids}`,
});
const thumb = (created_at = LATEST, login = OWNER): Node => ({ user: { login }, created_at });

/** After LATEST: when a comment made at LATEST was edited. */
const EDITED = '2026-10-05T00:00:00Z';

/**
 * The work rules on slice `issue`, with GitHub's GraphQL API listing each
 * comment's revisions by `revisions`, newest first, the comment as written
 * last; or refusing it, as a Claude cloud session's proxy does. Also how many
 * times they asked GraphQL.
 */
async function withEdits(issue: Node, revisions: Record<string, string[]> | 'refused', accounts: Settings = ACCOUNTS): Promise<{ problems: string[]; graphql: number }> {
  const sys = new FakeSys();
  github(sys, issue);
  sys.route('POST', '/graphql', () => {
    if (revisions === 'refused') return { status: 403, json: { message: 'Forbidden' } };
    const { ids } = (sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables;
    const nodes = ids.map((id) => ({ id, userContentEdits: { totalCount: revisions[id]?.length ?? 0, nodes: (revisions[id] ?? []).map((login) => ({ editor: { login } })) } }));
    return { status: 200, json: { data: { nodes } } };
  });
  const found = await sliceProblems(sys, 'tok', SLUG, 12, accounts, {});
  return { problems: found, graphql: sys.requests.filter((request) => request.url.endsWith('/graphql')).length };
}

const OTHERS_EDITED = ' (a "Decision:" comment someone other than an owner edited does not count)';
const UNREAD = ' (an edited "Decision:" comment counts only once GitHub\'s GraphQL API shows owners made every edit, and it did not answer here)';

async function problems(issue: Node | null, pulls: Node[] = [], mine: { pull?: number; branch?: string } = {}, accounts: Settings = ACCOUNTS): Promise<string[]> {
  const sys = new FakeSys();
  github(sys, issue, pulls);
  return sliceProblems(sys, 'tok', SLUG, 12, accounts, mine);
}

/** A second owner and a second agent, as settings listing two of each name them. */
const OWNER_2 = 'Second-Owner';
const AGENT_2 = 'OtherBot';
const TEAM = { owners: [OWNER, OWNER_2], agents: [AGENT, AGENT_2] };
const TEAM_SETTINGS = JSON.stringify({ owner: TEAM.owners, agent: TEAM.agents });

describe('slicesNamed', () => {
  it('reads "Slice: #N" lines and issue links, once each', () => {
    assert.deepEqual(slicesNamed('Intro\nSlice: #12\nslice:  https://github.com/a/b/issues/7 \nSlice: #12\nnot Slice: #9'), [12, 7]);
    assert.deepEqual(slicesNamed('Fixes #12'), []);
  });
});

describe('section', () => {
  it("reads a body's section up to the next one, or nothing when it is missing or empty", () => {
    const body = 'Intro\r\n**Why:** because\r\n- **Bold.** a point\r\n**Needs:** —\n**Empty:**  \n**Cost:**';
    assert.equal(section(body, 'why'), 'because\n- **Bold.** a point');
    assert.equal(section(body, 'Needs'), '—');
    assert.equal(section(body, 'Empty'), undefined);
    assert.equal(section(body, 'Cost'), undefined);
    assert.equal(section(body, 'You will see'), undefined);
  });
});

describe('sliceProblems', () => {
  it('lets an approved slice be built', async () => {
    assert.deepEqual(await problems(graph().issue), []);
  });

  for (const [name, change, problem] of [
    ['a missing issue', () => null, '#12 is not an issue in example-org/example-app'],
    ['an issue that is not a Slice', (g: ReturnType<typeof graph>) => ({ ...g.issue, type: null }), '#12 is not a Slice (its type is none)'],
    ['a slice with no work item', (g: ReturnType<typeof graph>) => ({ ...g.issue, parent: null }), '#12 is not a sub-issue of a Work item'],
    ['a slice under an issue that is not a Work item', (g: ReturnType<typeof graph>) => ({ ...g.issue, parent: { number: 10, type: { name: 'Slice' } } }), '#12 is not a sub-issue of a Work item'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      assert.deepEqual(await problems(change(graph())), [problem]);
    });
  }

  it('fails closed, saying so, when the parent cannot be read', async () => {
    const sys = new FakeSys();
    github(sys, graph().issue);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 403: Resource not accessible by integration)"]);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 404, json: { message: 'Not Found' } });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 404: Not Found)"]);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 502, json: null });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 502)"]);
  });

  it('refuses an unapproved start', async () => {
    const g = graph();
    g.timeline.splice(1, 1);
    assert.deepEqual(await problems(g.issue), ['work item #10 is not approved: example-owner adds the approved label before any slice starts']);
  });

  it('refuses an approval taken back', async () => {
    const g = graph();
    g.timeline.push({ event: 'unlabeled', created_at: LATER, actor: { login: OWNER }, label: { name: 'approved' } });
    assert.match((await problems(g.issue))[0] ?? '', /is not approved/);
  });

  it('refuses an approval by anyone but the owner', async () => {
    const g = graph();
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: { login: AGENT }, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue), ['work item #10 was labeled approved by ExampleBot, not example-owner']);
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: null, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue), ['work item #10 was labeled approved by someone unknown, not example-owner']);
  });

  it('ignores other labels', async () => {
    const g = graph();
    g.timeline.push({ event: 'labeled', created_at: LATER, actor: { login: AGENT }, label: { name: 'mechanical' } });
    assert.deepEqual(await problems(g.issue), []);
  });

  describe('a slice added after approval', () => {
    const added = (): ReturnType<typeof graph> => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
      return g;
    };
    const proposed =
      '#12 was added to work item #10 after its approval; example-owner reacts 👍 on ExampleBot\'s proposal on #12, or adds a "Decision:" comment naming #12, or #12 links example-owner\'s request for it on #10';
    const refused = `${proposed}; ExampleBot proposes it with: process-rules propose 12`;

    it('is refused without the owner\'s decision', async () => {
      assert.deepEqual(await problems(added().issue), [refused]);
    });

    it('passes with the owner\'s Decision: comment naming it on the work item', async () => {
      const g = added();
      g.timeline.push(comment('Decision: add #12, it is needed'));
      assert.deepEqual(await problems(g.issue), []);
    });

    it('passes with the owner\'s Decision: comment on the slice', async () => {
      const g = added();
      g.comments.push(comment('Decision: keep it'));
      assert.deepEqual(await problems(g.issue), []);
    });

    for (const [name, made] of [
      ['by the agent', comment('Decision: add #12', LATEST, AGENT)],
      ['before the slice was added', comment('Decision: add #12', APPROVED)],
      ['naming another slice', comment('Decision: add #120')],
      ['without the Decision: prefix', comment('ok, add #12')],
      ['with no author', { ...comment('Decision: add #12'), user: null }],
    ] as const) {
      it(`ignores a comment ${name}`, async () => {
        const g = added();
        g.timeline.push(made);
        assert.deepEqual(await problems(g.issue), [refused]);
      });
    }

    describe('a batch answer on the Approvals issue', () => {
      const batched = `${proposed}, or example-owner comments on #700, the Approvals issue, with a first line "Decision: approve #12"`;
      const proposes = '; ExampleBot proposes it with: process-rules propose 12';

      it("passes when the first line of the owner's comment there approves it among others", async () => {
        const g = added();
        g.approvals.push(comment('Decision: approve #31 #12 #40\nThe rest are reasons.'));
        assert.deepEqual(await problems(g.issue, [], {}, WITH_APPROVALS), []);
      });

      for (const [name, made] of [
        ['naming it only below the first line', comment('Decision: approve #31\nNot #12 yet: W-36 lands first.')],
        ['by the agent', comment('Decision: approve #12', LATEST, AGENT)],
        ['made before the slice was added', comment('Decision: approve #12', APPROVED)],
        ['that does not open "Decision: approve"', comment('Decision: #12 is fine')],
        ["naming another repository's #12, or #120", comment('Decision: approve other/repo#12 #120')],
      ] as const) {
        it(`ignores a comment there ${name}, and says how to answer`, async () => {
          const g = added();
          g.approvals.push(made);
          assert.deepEqual(await problems(g.issue, [], {}, WITH_APPROVALS), [`${batched}${proposes}`]);
        });
      }

      it('reads no Approvals issue where the settings name none', async () => {
        const g = added();
        g.approvals.push(comment('Decision: approve #12'));
        const sys = new FakeSys();
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), [refused]);
        assert.equal(sys.requests.some((request) => request.url.includes(`/issues/${APPROVALS}/`)), false);
      });

      it('answers nothing, and fails nothing, where GitHub cannot find the Approvals issue', async () => {
        assert.deepEqual(await problems(added().issue, [], {}, { ...ACCOUNTS, approvals: 701 }), [`${batched.replace('#700', '#701')}${proposes}`]);
      });

      it('refuses one the agent edited, and takes one owners alone edited', async () => {
        const g = added();
        const made = comment('Decision: approve #12', LATEST, OWNER, EDITED);
        g.approvals.push(made);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [AGENT, OWNER] }, WITH_APPROVALS), { problems: [`${batched}${OTHERS_EDITED}${proposes}`], graphql: 1 });
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [OWNER, OWNER] }, WITH_APPROVALS), { problems: [], graphql: 1 });
      });
    });

    describe("an owner's edited Decision:", () => {
      const proposes = '; ExampleBot proposes it with: process-rules propose 12';

      it('is refused when the agent edited it, on the slice or on the work item', async () => {
        const g = added();
        const made = comment('Decision: keep it', LATEST, OWNER, EDITED);
        g.comments.push(made);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [AGENT, OWNER] }), { problems: [`${proposed}${OTHERS_EDITED}${proposes}`], graphql: 1 });
        const h = added();
        const there = comment('Decision: add #12', LATEST, OWNER, EDITED);
        h.timeline.push(there);
        // An agent's edit counts against it even when an owner edited it again after.
        assert.deepEqual(await withEdits(h.issue, { [there.id as string]: [OWNER, AGENT, OWNER] }), { problems: [`${proposed}${OTHERS_EDITED}${proposes}`], graphql: 1 });
      });

      it('passes when owners alone edited it, on the slice or on the work item', async () => {
        const g = added();
        const made = comment('Decision: keep it', LATEST, OWNER, EDITED);
        g.comments.push(made);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [OWNER, OWNER] }), { problems: [], graphql: 1 });
        const h = added();
        const there = comment('Decision: add #12', LATEST, OWNER, EDITED);
        h.timeline.push(there);
        assert.deepEqual(await withEdits(h.issue, { [there.id as string]: [OWNER, OWNER] }), { problems: [], graphql: 1 });
      });

      it('does not count where GraphQL is refused, and says why', async () => {
        const g = added();
        g.comments.push(comment('Decision: keep it', LATEST, OWNER, EDITED));
        assert.deepEqual(await withEdits(g.issue, 'refused'), { problems: [`${proposed}${UNREAD}${proposes}`], graphql: 1 });
      });

      it('asks GraphQL nothing when an unedited decision, or a request, settles it', async () => {
        const g = added();
        g.comments.push(comment('Decision: keep it', LATEST, OWNER, EDITED), comment('Decision: keep it'));
        assert.deepEqual(await withEdits(g.issue, 'refused'), { problems: [], graphql: 0 });
        const h = added();
        const request = { ...comment('Please add the thing', APPROVED), id: 4321 };
        h.issue.body = `${h.issue.body as string}\n\nRequested: https://github.com/${SLUG}/issues/10#issuecomment-4321`;
        h.timeline.push(request, comment('Decision: add #12', LATEST, OWNER, EDITED));
        assert.deepEqual(await withEdits(h.issue, 'refused'), { problems: [], graphql: 0 });
      });

      it("still passes with the owner's 👍 on the proposal", async () => {
        const g = added();
        const made = comment('Decision: keep it', LATEST, OWNER, EDITED);
        const proposal = comment('Proposal: add #12', LATER, AGENT);
        g.comments.push(made, proposal);
        g.thumbs.set(proposal.id as string, [thumb()]);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [AGENT, OWNER] }), { problems: [], graphql: 1 });
      });
    });

    describe("a request on the work item the slice links", () => {
      const LINK = `https://github.com/${SLUG}/issues/10#issuecomment-`;
      /** Slice #12 added after approval, its body linking `link`, with `made` on the work item. */
      const linking = (made: Node, link = `${LINK}${made.id as number}`): ReturnType<typeof graph> => {
        const g = added();
        g.issue.body = `${g.issue.body as string}\n\nRequested: ${link}`;
        g.timeline.push(made);
        return g;
      };
      const request = (created_at = APPROVED, login = OWNER, edited: string | null = null): Node => ({ ...comment('Please add the thing', created_at, login, edited), id: 4321 });

      it("passes with the owner's comment, made before the slice was added", async () => {
        assert.deepEqual(await problems(linking(request()).issue), []);
        // GitHub writes a repository's name as it likes; the link may differ in case.
        assert.deepEqual(await problems(linking(request(), `${LINK.replace(SLUG, SLUG.toUpperCase())}4321`).issue), []);
      });

      for (const [name, made, link] of [
        ['by anyone else', request(APPROVED, AGENT), undefined],
        ['with no author', { ...request(), user: null }, undefined],
        ['made after the slice was added', request(LATEST), undefined],
        ['edited since it was made', request(APPROVED, OWNER, APPROVED.replace('02T', '02T01')), undefined],
        ['on another issue', request(), `https://github.com/${SLUG}/issues/11#issuecomment-4321`],
        ['in another repository', request(), `https://github.com/example-org/other-app/issues/10#issuecomment-4321`],
        ['that is not the one linked', request(), `${LINK}43210`],
      ] as const) {
        it(`does not pass with a comment ${name}`, async () => {
          assert.deepEqual(await problems(linking(made, link).issue), [refused]);
        });
      }

      it('does not pass when the slice links nothing, or GitHub holds no such comment', async () => {
        const g = added();
        g.timeline.push(request());
        assert.deepEqual(await problems(g.issue), [refused]);
        const h = added();
        h.issue.body = `${LINK}4321`;
        assert.deepEqual(await problems(h.issue), [refused]);
      });
    });

    it('checks the latest addition when a slice is removed and added again', async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } });
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it('ignores the add of another slice', async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_added', created_at: LATEST, sub_issue: null });
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 13 } });
      g.siblings.push({ number: 14, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATEST, parent_issue: null }] });
      assert.deepEqual(await problems(g.issue), []);
    });

    it("reads a late addition from the slice's own timeline when GITHUB_TOKEN hides which issue was added", async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: T0, sub_issue: null };
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      g.own.push({ event: 'parent_issue_added', created_at: LATER, parent_issue: null });
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it("owes the owner's say for a hidden late addition no sub-issue accounts for", async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: T0, sub_issue: null };
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      // The slice's own record is only its first addition, before approval: the later one may be it, added again.
      assert.deepEqual(await problems(g.issue), [refused]);
      g.own.length = 0;
      assert.deepEqual(await problems(g.issue), [refused], 'with no record of its own either');
      g.timeline.pop();
      assert.deepEqual(await problems(g.issue), [], 'hidden additions before approval owe nothing');
    });

    it("puts a hidden late addition down to the sibling whose own timeline records it", async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      g.siblings.push({ number: 13, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATER, parent_issue: null }] });
      assert.deepEqual(await problems(g.issue), []);
      g.siblings[0] = { number: 13, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATEST, parent_issue: null }] };
      assert.deepEqual(await problems(g.issue), [refused], 'a sibling added at another moment does not account for it');
    });

    describe("the owner's 👍 on the agent's proposal", () => {
      /** Slice #12 added after approval, with the agent's proposal on it and these 👍s. */
      const withProposal = (thumbs: Node[], made: Node = comment('Proposal: add #12 (Add the thing) to work item #10', LATER, AGENT)): ReturnType<typeof graph> => {
        const g = added();
        g.comments.push(made);
        g.thumbs.set(made.id as string, thumbs);
        return g;
      };

      it('reads every page of a proposal\'s 👍s', async () => {
        assert.deepEqual(await problems(withProposal([...Array.from({ length: 100 }, () => thumb(LATEST, AGENT)), thumb()]).issue), []);
      });

      it('passes, made after the slice was added', async () => {
        assert.deepEqual(await problems(withProposal([thumb(LATEST, AGENT), thumb()]).issue), []);
      });

      it('passes, made after the proposal was last edited', async () => {
        const made = comment('Proposal: add #12', LATER, AGENT, LATER);
        assert.deepEqual(await problems(withProposal([thumb()], made).issue), []);
      });

      // The refusal names the propose command while the agent's proposal is missing.
      for (const [name, thumbs, made, expected] of [
        ['by the agent', [thumb(LATEST, AGENT)], undefined, proposed],
        ['by anyone else', [thumb(LATEST, 'someone'), { user: null, created_at: LATEST }], undefined, proposed],
        ['made before the slice was added', [thumb(APPROVED)], undefined, proposed],
        ['on a proposal edited after it', [thumb(LATER)], comment('Proposal: add #12', LATER, AGENT, LATEST), proposed],
        ["on the owner's own proposal", [thumb()], comment('Proposal: add #12', LATER, OWNER), refused],
        ['on an agent comment that is not a proposal', [thumb()], comment('Added #12 for the owner', LATER, AGENT), refused],
        ['on a proposal for another issue', [thumb()], comment('Proposal: drop state #30 (of #12)', LATER, AGENT), refused],
        ['on a proposal naming #12abc', [thumb()], comment('Proposal: add #12abc', LATER, AGENT), refused],
      ] as const) {
        it(`does not pass when ${name}`, async () => {
          assert.deepEqual(await problems(withProposal([...thumbs], made).issue), [expected]);
        });
      }

      it('finds a proposal that later comments pushed back, reading every page of the slice\'s comments', async () => {
        const sys = new FakeSys();
        const g = added();
        const made = comment('Proposal: add #12', LATER, AGENT);
        g.thumbs.set(made.id as string, [thumb()]);
        for (let i = 0; i < 100; i++) g.comments.push(comment('Later talk', LATEST, AGENT));
        g.comments.push(made);
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
        assert.ok(sys.requests.some((r) => r.url === `${ISSUES}/12/comments?per_page=100&page=2`));
      });

      it('reads no reactions when a Decision: settles it, or nothing was proposed', async () => {
        const sys = new FakeSys();
        const g = withProposal([thumb()]);
        g.comments.push(comment('Decision: keep it'));
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
        const none = new FakeSys();
        github(none, added().issue);
        await sliceProblems(none, 'tok', SLUG, 12, ACCOUNTS, {});
        for (const run of [sys, none]) assert.ok(!run.requests.some((r) => r.url.includes('/reactions')));
      });

      it("reads each proposal's 👍s, a deleted proposal having none", async () => {
        const sys = new FakeSys();
        const g = added();
        g.comments.push(comment('Proposal: add #12', LATER, AGENT));
        g.comments.push({ ...comment('Proposal: add #12', LATER, AGENT), id: 'gone' });
        const last = comment('Proposal: add #12', LATER, AGENT);
        g.comments.push(last);
        g.thumbs.set(last.id as string, [thumb()]);
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
        assert.equal(sys.requests.filter((r) => r.url.includes('/reactions')).length, 3);
      });
    });
  });

  describe('a dropped state', () => {
    const state = (extra: Node = {}): Node => ({
      number: 30,
      type: { name: 'State' },
      state_reason: 'not_planned',
      closed_at: LATER,
      comments: [],
      ...extra,
    });
    const refused =
      'state #30 was closed as not planned after approval; example-owner reacts 👍 on ExampleBot\'s proposal for it on #12, or adds a "Decision:" comment to it; ExampleBot proposes it with: process-rules propose 30';

    it('is refused without the owner\'s decision', async () => {
      const g = graph();
      g.states.push(state());
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it("passes with the owner's Decision: on the state, or naming it on the slice", async () => {
      const g = graph();
      g.states.push(state({ comments: [comment('Decision: drop it')] }));
      assert.deepEqual(await problems(g.issue), []);
      const h = graph();
      h.states.push(state());
      h.comments.push(comment('Decision: drop #30'));
      assert.deepEqual(await problems(h.issue), []);
    });

    it("refuses the owner's Decision: the agent edited, on the state or the slice, and takes one owners alone edited", async () => {
      const onState = comment('Decision: drop it', LATEST, OWNER, EDITED);
      const g = graph();
      g.states.push(state({ comments: [onState] }));
      const why = refused.replace('; ExampleBot proposes', `${OTHERS_EDITED}; ExampleBot proposes`);
      assert.deepEqual(await withEdits(g.issue, { [onState.id as string]: [AGENT, OWNER] }), { problems: [why], graphql: 1 });
      assert.deepEqual(await withEdits(g.issue, { [onState.id as string]: [OWNER, OWNER] }), { problems: [], graphql: 1 });
      const onSlice = comment('Decision: drop #30', LATEST, OWNER, EDITED);
      const h = graph();
      h.states.push(state());
      h.comments.push(onSlice);
      assert.deepEqual(await withEdits(h.issue, { [onSlice.id as string]: [AGENT, OWNER] }), { problems: [why], graphql: 1 });
      // An unedited Decision: on the state still settles it, and needs no GraphQL.
      const i = graph();
      i.states.push(state({ comments: [comment('Decision: drop it')] }));
      i.comments.push(onSlice);
      assert.deepEqual(await withEdits(i.issue, 'refused'), { problems: [], graphql: 0 });
    });

    it("passes with the owner's batch answer on the Approvals issue made after the state was dropped, not before", async () => {
      const g = graph();
      g.states.push(state());
      g.approvals.push(comment('Decision: approve #30'));
      assert.deepEqual(await problems(g.issue, [], {}, WITH_APPROVALS), []);
      const h = graph();
      h.states.push(state());
      h.approvals.push(comment('Decision: approve #30', APPROVED));
      const batched = refused.replace('; ExampleBot proposes', ', or example-owner comments on #700, the Approvals issue, with a first line "Decision: approve #30"; ExampleBot proposes');
      assert.deepEqual(await problems(h.issue, [], {}, WITH_APPROVALS), [batched]);
    });

    it('reads the Approvals issue once a check, for an added slice and a dropped state alike', async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
      g.states.push(state());
      g.approvals.push(comment('Decision: approve #30 #12'));
      const sys = new FakeSys();
      github(sys, g.issue);
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, WITH_APPROVALS, {}), []);
      assert.equal(sys.requests.filter((request) => request.url.includes(`/issues/${APPROVALS}/comments`)).length, 1);
    });

    it("passes with the owner's 👍 on the agent's proposal for it on the slice", async () => {
      const g = graph();
      g.states.push(state());
      const made = comment('Proposal: drop state #30 (Empty list), closed as not planned', LATER, AGENT);
      g.comments.push(made);
      g.thumbs.set(made.id as string, [thumb()]);
      assert.deepEqual(await problems(g.issue), []);
      g.thumbs.set(made.id as string, [thumb(LATEST, AGENT)]);
      assert.deepEqual(await problems(g.issue), [refused.replace(/; ExampleBot proposes it with: .*$/, '')]);
    });

    describe('past the first page of states', () => {
      /** Slice #12 with 150 states: 100 on the first page, 50 on a second, the dropped one #149 among them. */
      const many = (dropped: Node): ReturnType<typeof graph> => {
        const g = graph();
        for (let n = 0; n < 149; n++) g.states.push(state({ number: n, closed_at: null }));
        g.states.push(state({ number: 149, ...dropped }));
        return g;
      };

      it('refuses a state dropped on the second page', async () => {
        assert.deepEqual(await problems(many({}).issue), [refused.replaceAll('#30', '#149').replace('propose 30', 'propose 149')]);
      });

      it("passes with the owner's Decision: among the state's earlier comments", async () => {
        const comments = [...Array.from({ length: 100 }, () => comment('a note', LATER, AGENT)), comment('Decision: drop it')];
        assert.deepEqual(await problems(many({ comments }).issue), []);
      });
    });

    for (const [name, extra] of [
      ['completed', { state_reason: 'completed' }],
      ['dropped before approval', { closed_at: T0 }],
      ['open', { closed_at: null }],
      ['not a State', { type: { name: 'Brief' } }],
    ] as const) {
      it(`ignores a state ${name}`, async () => {
        const g = graph();
        g.states.push(state(extra));
        assert.deepEqual(await problems(g.issue), []);
      });
    }
  });

  describe('a second pull request', () => {
    const pull = (number: number, body: string | null, ref = `b${number}`, repo: string | null = SLUG): Node => ({
      number,
      body,
      head: { ref, repo: repo === null ? null : { full_name: repo } },
    });

    it('is refused', async () => {
      assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12'), pull(6, null), pull(7, 'Slice: #13')]), [
        '#12 already has pull request #5; one slice, one pull request',
      ]);
    });

    it('does not count the pull request or branch being checked', async () => {
      assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12')], { pull: 5 }), []);
      assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12', 'feature', 'Example-Org/Example-App')], { branch: 'feature' }), []);
    });

    it("counts a fork's pull request from a branch of the same name", async () => {
      assert.deepEqual(await problems(graph().issue, [pull(6, 'Slice: #12', 'feature', 'someone/example-app'), pull(7, 'Slice: #12', 'feature', null)], { branch: 'feature' }), [
        '#12 already has pull request #6; one slice, one pull request',
        '#12 already has pull request #7; one slice, one pull request',
      ]);
    });

    it('reads every page of open pull requests', async () => {
      const sys = new FakeSys();
      github(sys, graph().issue, Array.from({ length: 100 }, (_, i) => pull(100 + i, 'none')));
      sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=2`, { status: 200, json: [pull(9, 'Slice: #12')] });
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ['#12 already has pull request #9; one slice, one pull request']);
    });
  });

  it('reads every page of the work item\'s timeline', async () => {
    const sys = new FakeSys();
    const g = graph();
    // The approval comes after 100 other events, on the second page.
    g.timeline.splice(1, 0, ...Array.from({ length: 100 }, () => ({ event: 'cross-referenced', created_at: T0 })));
    github(sys, g.issue);
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
    assert.ok(sys.requests.some((r) => r.url === `${ISSUES}/10/timeline?per_page=100&page=2`));
  });

  it('says how to fix a client workflow without issues: read', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${ISSUES}/12`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /needs issues: read, so run process-rules onboard to update it/);
  });

  it('throws when GitHub will not answer', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${ISSUES}/12`, { status: 403, json: { message: 'no access' } });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /cannot read #12: no access \(\/repos\/example-org\/example-app\/issues\/12\)/);
    sys.route('GET', `${ISSUES}/12`, { status: 502, json: null });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /cannot read #12: HTTP 502/);
    const listless = new FakeSys();
    github(listless, graph().issue);
    listless.route('GET', `${ISSUES}/12/comments?per_page=100&page=1`, { status: 200, json: {} });
    await assert.rejects(sliceProblems(listless, 'tok', SLUG, 12, ACCOUNTS, {}), /GitHub did not answer a list \(\/repos\/example-org\/example-app\/issues\/12\/comments\)/);
    sys.routes.delete(`GET ${ISSUES}/12`);
    github(sys, graph().issue);
    sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=1`, { status: 403, json: null });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /cannot list open pull requests \(HTTP 403\)/);
  });
});

describe('prWorkRules', () => {
  const EVENT = '/tmp/event.json';
  function actions(pull: Node | undefined): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
    sys.files.set(EVENT, JSON.stringify(pull ? { pull_request: pull } : {}));
    return sys;
  }
  const agentPull = (body: string | null): Node => ({ number: 40, body, user: { login: AGENT }, head: { ref: 'work' } });
  async function check(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await prWorkRules(sys, io), out, err };
  }

  it('passes an agent pull request naming a slice that may be built', async () => {
    const sys = actions(agentPull('Builds the thing.\n\nSlice: #12'));
    github(sys, graph().issue, [{ number: 40, body: 'Slice: #12', head: { ref: 'work' } }]);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-work-rules: #40 builds slice #12, which may be built'], err: [] });
    assert.equal(sys.requests[0]?.token, 'ghs_run');
  });

  it('passes a fix: a pull request naming the closed slice it fixes, with a State filed under it after approval', async () => {
    const g = graph();
    g.issue.state = 'closed';
    g.issue.closed_at = LATER;
    g.states.push({ number: 31, title: 'Fix: the thing on narrow pages', type: { name: 'State' }, state_reason: null, closed_at: null, comments: [] });
    const sys = actions(agentPull('Fixes state #31.\n\nSlice: #12'));
    github(sys, g.issue);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-work-rules: #40 builds slice #12, which may be built'], err: [] });
  });

  it('refuses an agent pull request whose slice may not be built', async () => {
    const g = graph();
    g.timeline.splice(1, 1);
    const sys = actions(agentPull('Slice: #12'));
    github(sys, g.issue);
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, ['✗ work item #10 is not approved: example-owner adds the approved label before any slice starts', 'pr-work-rules: refused by the work rules']);
  });

  for (const [body, problem] of [
    [null, '#40 names no slice; add a line "Slice: #N" to its description'],
    ['Slice: #12\nSlice: #13', '#40 names 2 slices (#12, #13); an agent pull request builds exactly one'],
  ] as const) {
    it(`refuses an agent pull request with body ${JSON.stringify(body)}`, async () => {
      assert.deepEqual((await check(actions(agentPull(body)))).err[0], `✗ ${problem}`);
    });
  }

  describe("onboard's pull request", () => {
    const onboardPull = (repo = SLUG): Node => ({ number: 42, body: 'onboard', user: { login: AGENT }, head: { ref: 'process-rules/onboard', repo: { full_name: repo } } });
    const files = (sys: FakeSys, list: Node[]): void => {
      sys.route('GET', `/repos/${SLUG}/pulls/42/files?per_page=100&page=1`, { status: 200, json: list });
    };

    it('passes one changing only the files onboard writes, naming no slice', async () => {
      const sys = actions(onboardPull('Example-Org/Example-App'));
      files(sys, [{ filename: '.github/process-rules.json', status: 'modified' }, { filename: '.claude/settings.json', status: 'added' }, { filename: '.github/workflows/process-rules.yml' }, { filename: '.github/process-rules/cloud-setup.sh', status: 'added' }]);
      assert.deepEqual(await check(sys), { code: 0, out: ["✓ pr-work-rules: #42 is onboard's, changing only the files onboard writes, so it names no slice"], err: [] });
      assert.equal(sys.requests[0]?.token, 'ghs_run');
    });

    for (const [name, list] of [
      ['changes another file', [{ filename: '.github/process-rules.json' }, { filename: 'src/app.ts' }]],
      // onboard leaves CODEOWNERS to the client, so a change to it is the work rules' to judge.
      ...(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const).map((filename) => [`changes ${filename}`, [{ filename: '.github/process-rules.json' }, { filename }]] as const),
      ['moves another file into one onboard writes', [{ filename: '.claude/settings.json', previous_filename: 'src/settings.json' }]],
      ['deletes one onboard writes', [{ filename: '.github/workflows/process-rules.yml', status: 'removed' }]],
    ] as const) {
      it(`holds one that ${name} to the work rules`, async () => {
        const sys = actions(onboardPull());
        files(sys, [...list]);
        assert.deepEqual((await check(sys)).err[0], '✗ #42 names no slice; add a line "Slice: #N" to its description');
      });
    }

    it("holds a fork's branch of that name to the work rules, without reading its files", async () => {
      const sys = actions(onboardPull('someone/example-app'));
      assert.deepEqual((await check(sys)).err[0], '✗ #42 names no slice; add a line "Slice: #N" to its description');
      assert.ok(!sys.requests.some((r) => r.url.includes('/files')));
    });
  });

  it("leaves the owner's pull requests alone", async () => {
    const sys = actions({ number: 41, body: null, user: { login: OWNER }, head: { ref: 'x' } });
    assert.deepEqual(await check(sys), { code: 0, out: ['pr-work-rules: #41 is by example-owner, not an agent; the work rules bind agent pull requests'], err: [] });
  });

  it('skips events that are not pull requests', async () => {
    assert.deepEqual((await check(actions(undefined))).out, ['pr-work-rules: not a pull request; nothing to check']);
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(check(new FakeSys()), /pr-work-rules runs in GitHub Actions/);
  });

  it('reads the settings from the checkout', async () => {
    const sys = actions(agentPull('Slice: #12'));
    github(sys, graph().issue);
    await check(sys);
    assert.equal(sys.cwd, ROOT);
  });
});

describe('prePush', () => {
  const LOCAL = 'a'.repeat(40);
  const REMOTE = 'b'.repeat(40);
  const ZERO = '0'.repeat(40);
  function session(log: string): FakeSys {
    const sys = new FakeSys();
    sys.env = { PROCESS_RULES_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
    sys.execOverride = (call) => (call.args[0] === 'log' ? { code: 0, stdout: log, stderr: '' } : undefined);
    github(sys, graph().issue);
    sys.acceptToken('ghp_good', AGENT);
    return sys;
  }
  async function push(sys: FakeSys, lines: string): Promise<{ code: number; err: string[] }> {
    const { io, err } = capture();
    return { code: await prePush(sys, io, lines, 'https://github.com/example-org/example-app.git'), err };
  }

  it('lets an agent push commits naming a slice that may be built', async () => {
    const sys = session('Add the thing\n\nSlice: #12\n');
    assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
    assert.deepEqual(sys.calls.find((c) => c.args[0] === 'log')?.args, ['log', '--format=%B', LOCAL, '--not', REMOTE, '--remotes']);
    assert.equal(sys.requests[0]?.token, 'ghp_good');
  });

  it('reads only commits no remote has for a new branch', async () => {
    const sys = session('Slice: #12');
    await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${ZERO}\n`);
    assert.deepEqual(sys.calls.find((c) => c.args[0] === 'log')?.args, ['log', '--format=%B', LOCAL, '--not', '--remotes']);
  });

  it('refuses commits naming no slice, or two', async () => {
    assert.deepEqual(await push(session('Tidy up'), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), {
      code: 1,
      err: ['✗ the commits for work name no slice; add a trailer "Slice: #N" to a commit message', 'pre-push: refused by the work rules'],
    });
    assert.equal((await push(session('Slice: #12\nSlice: #13'), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).err[0], '✗ the commits for work name 2 slices (#12, #13); one push builds one slice');
  });

  describe('a push of only a merge, such as of the default branch', () => {
    const MAIN = 'c'.repeat(40);
    const MERGE = "Merge branch 'main' into work\n";
    function merged(parents: string, pushed = MERGE): FakeSys {
      const sys = session('');
      sys.execOverride = (call) => {
        if (call.args[0] !== 'log') return undefined;
        if (call.args.includes('--format=%P')) return { code: 0, stdout: parents, stderr: '' };
        const stdout = call.args.includes('--no-merges') ? 'Add the thing\n\nSlice: #12\n' : pushed;
        return { code: 0, stdout, stderr: '' };
      };
      return sys;
    }

    it("is judged by the branch's own commits", async () => {
      const sys = merged(`${REMOTE} ${MAIN}\n`);
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), { code: 0, err: [] });
      assert.deepEqual(sys.calls.filter((c) => c.args[0] === 'log').at(-1)?.args, ['log', '--no-merges', '--format=%B', LOCAL, '--not', MAIN]);
    });

    it('is refused beside a commit of its own naming no slice', async () => {
      const sys = merged(`${REMOTE} ${MAIN}\n${REMOTE}\n`, `${MERGE}\nTidy up\n`);
      assert.equal((await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).err[0], '✗ the commits for work name no slice; add a trailer "Slice: #N" to a commit message');
    });

    it('passes beside a commit of its own naming the slice, without reading past the merges', async () => {
      const sys = merged(`${REMOTE} ${MAIN}\n${REMOTE}\n`, `${MERGE}\nAdd more\n\nSlice: #12\n`);
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), { code: 0, err: [] });
      assert.ok(!sys.calls.some((c) => c.args.includes('--no-merges')));
    });
  });

  it('refuses a slice that may not be built', async () => {
    const sys = session('Slice: #12');
    const g = graph();
    g.timeline.splice(1, 1);
    github(sys, g.issue);
    assert.equal((await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).code, 1);
  });

  it('passes deletes, pushes with nothing new, and pushes outside agent sessions', async () => {
    assert.equal((await push(session('Slice: #12'), `(delete) ${ZERO} refs/heads/work ${REMOTE}\n\n`)).code, 0);
    assert.equal((await push(session(''), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).code, 0);
    const owner = session('Tidy up');
    owner.env = {};
    assert.equal((await push(owner, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).code, 0);
  });

  it('refuses an agent session with no token, at the identity guard', async () => {
    for (const token of [undefined, 'process-rules-no-agent-token']) {
      const sys = session('Slice: #12');
      sys.env = { PROCESS_RULES_AGENT: AGENT, ...(token ? { GH_TOKEN: token } : {}) };
      const { code, err } = await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`);
      assert.deepEqual({ code, last: err.at(-1) }, { code: 1, last: `pre-push: refused; an agent session pushes to GitHub only as ${AGENT}` });
    }
  });

  it('refuses work rules it cannot read when git pushes as the agent without GH_TOKEN', async () => {
    const sys = session('Slice: #12');
    sys.env = { PROCESS_RULES_AGENT: AGENT };
    const log = sys.execOverride;
    sys.execOverride = (call) =>
      call.args.join(' ') === 'credential fill' ? { code: 0, stdout: 'password=ghp_good\n', stderr: '' } : log(call);
    assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), {
      code: 1,
      err: ['✗ this agent session has no token, so the work rules cannot be checked; run process-rules doctor', 'pre-push: refused by the work rules'],
    });
  });

  it('counts the slices across every ref of one push', async () => {
    const sys = session('');
    sys.execOverride = (call) =>
      call.args[0] === 'log' ? { code: 0, stdout: call.args[2]?.endsWith(LOCAL) ? 'Slice: #12\n' : 'Slice: #13\n', stderr: '' } : undefined;
    const lines = `refs/heads/a ${LOCAL} refs/heads/a ${REMOTE}\nrefs/heads/b ${'c'.repeat(40)} refs/heads/b ${REMOTE}\n`;
    assert.equal((await push(sys, lines)).err[0], '✗ the commits for a, b name 2 slices (#12, #13); one push builds one slice');
  });

  it('refuses one slice pushed to two branches at once', async () => {
    const lines = `refs/heads/a ${LOCAL} refs/heads/a ${REMOTE}\nrefs/heads/b ${LOCAL} refs/heads/b ${REMOTE}\n`;
    assert.equal((await push(session('Slice: #12'), lines)).err[0], '✗ one push builds one slice on one branch; this one pushes a, b');
  });

  it('skips a ref line it cannot read', async () => {
    assert.equal((await push(session('Tidy up'), 'garbage\n')).code, 0);
  });

  it('throws when git log fails', async () => {
    const sys = session('');
    sys.execOverride = (call) => (call.args[0] === 'log' ? { code: 128, stdout: '', stderr: 'bad revision\n' } : undefined);
    await assert.rejects(push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), /git log failed: bad revision/);
  });

  describe('on a real git history, where the default branch carries other slices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-rules-pre-push-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const ENV = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    };
    let made = 0;
    /** Runs real git in `cwd`, failing the test on an error. */
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const commit = (cwd: string, message: string): string => {
      writeFileSync(join(cwd, `file-${++made}`), message);
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-q', '-m', message);
      return git(cwd, 'rev-parse', 'HEAD');
    };
    /**
     * A remote whose default branch, main, has squash-merged two other
     * slices, and a clone `name` of it with its work branch at main's first
     * commit; `other` is a second clone, from which main moves on.
     */
    function history(name: string): { clone: string; other: string } {
      const remote = join(dir, `${name}.git`);
      git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
      const other = join(dir, `${name}-other`);
      git(dir, 'clone', '-q', remote, other);
      git(other, 'switch', '-q', '-c', 'main');
      commit(other, 'Start');
      git(other, 'push', '-q', 'origin', 'main');
      const clone = join(dir, name);
      git(dir, 'clone', '-q', remote, clone);
      git(clone, 'switch', '-q', '-c', 'work');
      commit(other, 'Build P-20 (#30)\n\nSlice: #20');
      commit(other, 'Build P-21 (#31)\n\nSlice: #21');
      git(other, 'push', '-q', 'origin', 'main');
      return { clone, other };
    }
    /**
     * An agent session in `clone`, whose git log and rev-parse --verify are
     * real; GitHub names main's tip as `tip`, and compares main with each
     * commit `compared` names as its status says.
     */
    function real(clone: string, tip?: string, compared: Record<string, string> = {}): FakeSys {
      const sys = session('');
      sys.execOverride = (call) => {
        if (call.args[0] !== 'log' && call.args.slice(0, 3).join(' ') !== 'rev-parse --verify --quiet') return undefined;
        const result = spawnSync('git', call.args, { cwd: clone, encoding: 'utf8', env: ENV });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      };
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: { owner: { type: 'Organization' }, default_branch: 'main' } });
      sys.route('GET', `/repos/${SLUG}/git/ref/heads/main`, tip ? { status: 200, json: { object: { sha: tip } } } : { status: 404, json: { message: 'Not Found' } });
      for (const [commit, status] of Object.entries(compared)) sys.route('GET', `/repos/${SLUG}/compare/main...${commit}?per_page=1`, { status: 200, json: { status } });
      return sys;
    }
    const line = (clone: string, remote = ZERO): string => `refs/heads/work ${git(clone, 'rev-parse', 'HEAD')} refs/heads/work ${remote}\n`;
    /** Fetches main into FETCH_HEAD alone, as a single-branch clone does, and merges it. */
    const mergeFetched = (clone: string): void => {
      git(clone, 'fetch', '-q', 'origin', 'main');
      git(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
      git(clone, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    };

    it("passes a new branch's first push, naming its slice, beside main's slices", async () => {
      const { clone, other } = history('first');
      git(clone, 'fetch', '-q', 'origin');
      git(clone, 'reset', '-q', '--hard', 'origin/main');
      commit(clone, 'Add the thing\n\nSlice: #12');
      assert.deepEqual(await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone)), { code: 0, err: [] });
    });

    it("passes a merge of main whose commits name other slices, though the clone's ref for main is missing", async () => {
      const { clone, other } = history('merge');
      commit(clone, 'Add the thing\n\nSlice: #12');
      git(clone, 'push', '-q', 'origin', 'work');
      const pushed = git(clone, 'rev-parse', 'HEAD');
      mergeFetched(clone);
      const fetched = git(other, 'rev-parse', 'HEAD');
      assert.deepEqual(await push(real(clone, fetched), line(clone, pushed)), { code: 0, err: [] });
      // Main moves on after the fetch: GitHub's tip is not in the clone, so GitHub says what the merge brought.
      commit(other, 'Build P-22 (#32)\n\nSlice: #22');
      git(other, 'push', '-q', 'origin', 'main');
      const tip = git(other, 'rev-parse', 'HEAD');
      const sys = real(clone, tip, { [fetched]: 'behind' });
      assert.deepEqual(await push(sys, line(clone, pushed)), { code: 0, err: [] });
      assert.ok(sys.requests.some((r) => r.url.endsWith(`/compare/main...${fetched}?per_page=1`)));
      // Where GitHub cannot say, or says the merged commit is not on main, main's commits count as the push's own, as before.
      for (const compared of [{}, { [fetched]: 'diverged' }]) {
        assert.equal((await push(real(clone, tip, compared), line(clone, pushed))).err[0], '✗ the commits for work name 2 slices (#21, #20); one push builds one slice');
      }
    });

    it('asks GitHub nothing when the push names its one slice', async () => {
      const { clone } = history('asked');
      commit(clone, 'Add the thing\n\nSlice: #12');
      const sys = real(clone);
      assert.deepEqual(await push(sys, line(clone)), { code: 0, err: [] });
      assert.ok(!sys.requests.some((r) => r.url.includes('/compare/')));
    });

    it('passes a merge tip with no trailer, and a commit with none, on a branch that already names its slice', async () => {
      const { clone, other } = history('tip');
      commit(clone, 'Add the thing\n\nSlice: #12');
      git(clone, 'push', '-q', 'origin', 'work');
      const pushed = git(clone, 'rev-parse', 'HEAD');
      git(clone, 'fetch', '-q', 'origin');
      commit(clone, 'Tidy up');
      git(clone, 'merge', '-q', '--no-edit', 'origin/main');
      // GitHub's tip is newer than the clone has, so the remote-tracking ref alone says where main is.
      commit(other, 'Build P-22 (#32)\n\nSlice: #22');
      git(other, 'push', '-q', 'origin', 'main');
      assert.deepEqual(await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone, pushed)), { code: 0, err: [] });
    });

    it("refuses a push naming no slice on a branch whose own commits name two", async () => {
      const { clone, other } = history('two');
      commit(clone, 'Add the thing\n\nSlice: #12');
      commit(clone, 'Add another\n\nSlice: #13');
      git(clone, 'push', '-q', 'origin', 'work');
      const pushed = git(clone, 'rev-parse', 'HEAD');
      mergeFetched(clone);
      commit(clone, 'Tidy up');
      assert.deepEqual(await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone, pushed)), {
        code: 1,
        err: ['✗ the commits for work name 2 slices (#13, #12); one push builds one slice', 'pre-push: refused by the work rules'],
      });
    });

    it('refuses a push naming no slice on a branch whose own commits name none', async () => {
      const { clone, other } = history('none');
      commit(clone, 'Tidy up');
      assert.equal((await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone))).err[0], '✗ the commits for work name no slice; add a trailer "Slice: #N" to a commit message');
    });
  });

  describe('the work board', () => {
    /** The board's writes, as the option each sets on which item. */
    const moves = (board: RestBoard): string[] =>
      board.writes.map(({ path, body }) => `${path.split('/').at(-1)} ${(body as { fields: { id: number; value: string }[] }).fields.map((field) => `${field.id}:${field.value}`).join(' ')}`);
    const pushing = `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`;

    it('moves the slice to In Progress, its work item to Build, and a work item with no Step to Frame, through REST alone', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: [
          '✓ board: slice #12 is In Progress in "example-app work"',
          '✓ board: work item #10 is at Step Build in "example-app work"',
          '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
        ],
      });
      assert.deepEqual(moves(board), ['100 2:2_In-Progress', '101 3:3_Build', '102 3:3_Frame']);
      assert.deepEqual(
        board.projects[0]?.items.map((item) => item.values),
        [{ Status: 'In Progress' }, { Status: 'Todo', Step: 'Build' }, { Step: 'Frame' }, { Step: 'Frame' }],
      );
      // A cloud session's proxy refuses GraphQL, so the push never asks it.
      assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
      assert.ok(sys.requests.filter((r) => r.url.includes('projectsV2')).every((r) => r.token === 'ghp_good'));
    });

    it('moves nothing already there, closed, or on a Project without the field or option', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      const project = board.projects[0]!;
      project.items = [{ issue: 12, values: { Status: 'in progress' } }, { issue: 10, values: { Step: 'Build' } }, { issue: 21, values: { Step: 'Frame' } }];
      board.projects.push(
        { number: 5, title: 'other', fields: { Title: null, Status: ['Todo'], Notes: null }, items: [{ issue: 12, values: { Status: 'Todo' } }, { issue: 20, values: {} }] },
        { number: 6, title: 'no board', fields: { Title: null }, items: [{ issue: 12, values: {} }] },
      );
      assert.deepEqual(await push(sys, pushing), { code: 0, err: [] });
      assert.deepEqual(moves(board), []);
      // A Project with neither field is not read for its items.
      assert.ok(!sys.requests.some((r) => r.url.includes('/projectsV2/6/items')));
      const closed = session('Slice: #12');
      github(closed, { ...graph().issue, state: 'closed' });
      const untouched = new RestBoard(closed);
      assert.deepEqual(await push(closed, pushing), { code: 0, err: [] });
      assert.deepEqual(moves(untouched), []);
      assert.ok(!closed.requests.some((r) => r.url.includes('projectsV2')));
    });

    it('says when it cannot read the board, and lets the push go on', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      board.refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 403, json: { message: 'Forbidden' } } : undefined);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: ["! board: could not read where #12 and its work item are on the board, so nothing moved (GitHub's REST API refused GET /orgs/example-org/projectsV2?per_page=100: HTTP 403 Forbidden); the push goes on"],
      });
    });

    it('makes the other moves when GitHub refuses one', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      board.refuse = (method, path) => (method === 'PATCH' && path.endsWith('/items/101') ? { status: 403, json: { message: 'Resource not accessible by integration' } } : undefined);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: [
          '✓ board: slice #12 is In Progress in "example-app work"',
          '! board: work item #10 was not moved to Build in "example-app work" (GitHub\'s REST API refused PATCH /orgs/example-org/projectsV2/3/items/101: HTTP 403 Resource not accessible by integration)',
          '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
        ],
      });
    });

    it('moves nothing with the board feature off', async () => {
      const sys = session('Slice: #12');
      sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity', 'work-rules'] }));
      const board = new RestBoard(sys);
      assert.deepEqual(await push(sys, pushing), { code: 0, err: [] });
      assert.deepEqual(moves(board), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('projectsV2')));
    });

    it('moves nothing for a push the work rules refuse', async () => {
      const sys = session('Slice: #12');
      const g = graph();
      g.timeline.splice(1, 1);
      github(sys, g.issue);
      const board = new RestBoard(sys);
      assert.equal((await push(sys, pushing)).code, 1);
      assert.deepEqual(moves(board), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('projectsV2')));
    });
  });
});

describe('prMerged', () => {
  const EVENT = '/tmp/event.json';
  const ISSUE = `/repos/${SLUG}/issues/12`;
  function actions(pull: Node | undefined, defaultBranch = 'main'): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
    sys.files.set(EVENT, JSON.stringify({ ...(pull ? { pull_request: pull } : {}), repository: { default_branch: defaultBranch } }));
    github(sys, graph().issue);
    sys.route('POST', `${ISSUE}/comments`, { status: 201, json: {} });
    sys.route('PATCH', ISSUE, { status: 200, json: {} });
    return sys;
  }
  const merged = (body: string | null, base = 'main'): Node => ({ number: 40, body, merged: true, base: { ref: base } });
  async function run(sys: FakeSys): Promise<{ code: number; out: string[] }> {
    const { io, out } = capture();
    return { code: await prMerged(sys, io), out };
  }
  const writes = (sys: FakeSys): unknown[] => sys.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.url.replace('https://api.github.com', ''), r.body, r.token]);

  it('closes the slice a merged pull request names, with a comment linking it', async () => {
    const sys = actions(merged('Builds the thing.\n\nSlice: #12'));
    assert.deepEqual(await run(sys), { code: 0, out: ['✓ #12: closed, built in #40'] });
    assert.deepEqual(writes(sys), [
      ['POST', `${ISSUE}/comments`, { body: 'Built in #40, merged into main.' }, 'ghs_run'],
      ['PATCH', ISSUE, { state: 'closed', state_reason: 'completed' }, 'ghs_run'],
    ]);
  });

  it('comments on a slice GitHub closed already, and leaves an issue that is not a slice as it is', async () => {
    const sys = actions(merged('Closes #12\n\nSlice: #12\nSlice: #99'));
    const g = graph();
    g.issue.state = 'closed';
    github(sys, g.issue);
    assert.deepEqual(await run(sys), {
      code: 0,
      out: ['✓ #12 is closed already; commented that it was built in #40', '- #99 is not a Slice in example-org/example-app; left as it is'],
    });
    assert.deepEqual(writes(sys), [['POST', `${ISSUE}/comments`, { body: 'Built in #40, merged into main.' }, 'ghs_run']]);
  });

  it('comments only once, closed or open, however often it runs', async () => {
    const g = graph();
    g.comments.push(comment('Built in #400, merged into main.', LATEST, 'github-actions[bot]'), comment('Built in #40, merged into main.', LATEST, 'github-actions[bot]'));
    const open = actions(merged('Slice: #12'));
    github(open, g.issue);
    assert.deepEqual(await run(open), { code: 0, out: ['✓ #12: closed, built in #40'] });
    assert.deepEqual(writes(open), [['PATCH', ISSUE, { state: 'closed', state_reason: 'completed' }, 'ghs_run']]);
    g.issue.state = 'closed';
    const closed = actions(merged('Slice: #12'));
    github(closed, g.issue);
    assert.deepEqual(await run(closed), { code: 0, out: ['✓ #12 is closed already and says it was built in #40'] });
    assert.deepEqual(writes(closed), []);
  });

  it('comments on a slice whose only comment names another pull request', async () => {
    const g = graph();
    g.issue.state = 'closed';
    g.comments.push(comment('Built in #400, merged into main.', LATEST, 'github-actions[bot]'));
    const sys = actions(merged('Slice: #12'));
    github(sys, g.issue);
    assert.deepEqual((await run(sys)).out, ['✓ #12 is closed already; commented that it was built in #40']);
  });

  for (const [name, pull, line] of [
    ['a pull request closed unmerged', { number: 40, body: 'Slice: #12', merged: false, base: { ref: 'main' } }, 'pr-merged: not a merged pull request; nothing to close'],
    ['an event that is not a pull request', undefined, 'pr-merged: not a merged pull request; nothing to close'],
    ['a merge into another branch', merged('Slice: #12', 'stack'), 'pr-merged: #40 merged into stack, not main; its slices stay open until their work reaches main'],
    ['a pull request naming no slice', merged('Tidy up'), 'pr-merged: #40 names no slice; nothing to close'],
  ] as const) {
    it(`closes nothing for ${name}`, async () => {
      const sys = actions(pull as Node | undefined);
      assert.deepEqual(await run(sys), { code: 0, out: [line] });
      assert.deepEqual(writes(sys), []);
    });
  }

  it('closes nothing with the work rules off, or before the repo adopts process-rules', async () => {
    const off = actions(merged('Slice: #12'));
    off.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity'] }));
    assert.equal((await run(off)).out[0], 'pr-merged: work-rules is off in .github/process-rules.json; nothing to check');
    const before = actions(merged('Slice: #12'));
    before.files.delete(`${ROOT}/.github/process-rules.json`);
    assert.match((await run(before)).out[0] ?? '', /^pr-merged: /);
    assert.deepEqual([...writes(off), ...writes(before)], []);
  });

  it('closes nothing in a personal repository', async () => {
    const sys = actions(merged('Slice: #12'));
    sys.ownerType = 'User';
    assert.match((await run(sys)).out[0] ?? '', /^pr-merged: work-rules is off on a repository owned by a personal account/);
    assert.deepEqual(writes(sys), []);
  });

  it('says how to fix a client workflow that grants no issues: write', async () => {
    const sys = actions(merged('Slice: #12'));
    sys.route('POST', `${ISSUE}/comments`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(run(sys), /cannot close #12: Resource not accessible by integration; the client workflow needs a job with issues: write/);
    const refused = actions(merged('Slice: #12'));
    refused.route('PATCH', ISSUE, { status: 500, json: null });
    await assert.rejects(run(refused), /^Error: cannot close #12: HTTP 500$/);
    const g = graph();
    g.issue.state = 'closed';
    const closed = actions(merged('Slice: #12'));
    github(closed, g.issue);
    closed.route('POST', `${ISSUE}/comments`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(run(closed), /cannot comment on #12: Resource not accessible by integration; the client workflow needs a job with issues: write/);
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(run(new FakeSys()), /pr-merged runs in GitHub Actions/);
  });
});

describe('propose', () => {
  const ISSUE = `/repos/${SLUG}/issues/12`;
  /** An agent session, slice #12 added after approval, and state #30 of it dropped after approval. */
  function session(g = graph()): { sys: FakeSys; g: ReturnType<typeof graph> } {
    const sys = new FakeSys();
    sys.env = { PROCESS_RULES_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
    sys.acceptToken('ghp_good', AGENT);
    github(sys, g.issue);
    let made = 0;
    sys.route('POST', `${ISSUE}/comments`, () => ({ status: 201, json: { html_url: `https://github.com/example-org/example-app/issues/12#issuecomment-${++made}` } }));
    sys.route('POST', `${ISSUE}/labels`, { status: 200, json: [] });
    sys.route('DELETE', `${ISSUE}/labels/needs-owner`, { status: 200, json: [] });
    return { sys, g };
  }
  const owing = (): ReturnType<typeof graph> => {
    const g = graph();
    g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
    g.states.push({
      number: 30,
      title: 'Empty list',
      body: 'The list shows a note when empty.\n\n**Why:** the list is never empty now.\n\n**Cost:** nothing anyone would see.',
      type: { name: 'State' },
      state_reason: 'not_planned',
      closed_at: LATER,
      comments: [],
    });
    return g;
  };
  async function run(sys: FakeSys, number = 12): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await propose(sys, io, number), out, err };
  }
  const posted = (sys: FakeSys): string[] =>
    sys.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/comments')).map((r) => (r.body as { body: string }).body);

  it("proposes each decision the slice owes, as the agent, and labels it for the owner's Needs you view", async () => {
    const { sys } = session(owing());
    assert.deepEqual(await run(sys), {
      code: 0,
      out: [
        '✓ #12: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1',
        '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-2',
        "#12 is labeled needs-owner, waiting on example-owner's 👍 on https://github.com/example-org/example-app/issues/12#issuecomment-1 and https://github.com/example-org/example-app/issues/12#issuecomment-2",
      ],
      err: [],
    });
    const ask = '@example-owner: react 👍 to this comment to approve it, or comment "Decision:".';
    assert.deepEqual(posted(sys), [
      [
        'Proposal: add #12 (Add the thing) to work item #10, after its approval.',
        '**What changes:** the thing.\n- on every page',
        '**Why:** it is asked for.',
        '**What it costs:** one more slice of work item #10: the agent builds it in a pull request, which you review.',
        '**If you decline:** #12 is closed as not planned and nothing of it is built; work item #10 keeps what you approved.',
        ask,
      ].join('\n\n'),
      [
        "Proposal: drop state #30 (Empty list), closed as not planned after work item #10's approval.",
        '**What changes:** slice #12 is built without state #30, which you approved.',
        '**Why:** the list is never empty now.',
        '**What it costs:** nothing anyone would see.',
        '**If you decline:** state #30 is reopened and built as you approved it.',
        ask,
      ].join('\n\n'),
    ]);
    assert.deepEqual(sys.requests.find((r) => r.url.endsWith('/labels'))?.body, { labels: ['needs-owner'] });
  });

  it('refuses, posting nothing, while a body lacks what its proposal says', async () => {
    const g = owing();
    g.issue.body = 'Slice P-01 of #10.\n\n**You will see:**\n\n**Needs:** —';
    (g.states[0] as Node).body = null;
    const { sys } = session(g);
    assert.deepEqual(await run(sys), {
      code: 1,
      out: [],
      err: [
        '✗ #12\'s body has no "**You will see:**" or "**Why:**" section; write it there first, so the proposal says what changes and why',
        '✗ state #30\'s body has no "**Why:**" section; write it there first, so the proposal says what changes and why',
        'propose: refused by the work rules',
      ],
    });
    assert.deepEqual(posted(sys), []);
    // What is already proposed, or settled, needs nothing more.
    g.comments.push(comment('Proposal: add #12', LATER, AGENT));
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    assert.equal((await run(sys)).code, 0);
    assert.deepEqual(posted(sys), []);
  });

  it('proposes a state alone, given the state', async () => {
    const { sys } = session(owing());
    const { out } = await run(sys, 30);
    assert.equal(out[0], '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1');
    assert.equal(posted(sys).length, 1);
  });

  it("refuses a state whose slice cannot be read, saying so", async () => {
    const { sys } = session(owing());
    sys.route('GET', `/repos/${SLUG}/issues/30/parent`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    assert.deepEqual(await run(sys, 30), {
      code: 1,
      out: [],
      err: ["✗ could not read #30's parent (HTTP 403: Resource not accessible by integration)", 'propose: refused by the work rules'],
    });
    assert.deepEqual(posted(sys), []);
  });

  it("posts nothing twice, linking the waiting proposal itself, and keeps the label while the owner has not decided", async () => {
    const g = owing();
    const older = comment('Proposal: add #12', LATER, AGENT);
    const made = comment('Proposal: add #12', LATER, AGENT);
    g.comments.push(older, made);
    // On the slice, any Decision: also settles its addition.
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    const { sys } = session(g);
    // The newest proposal's own comment, never the slice's top or the needs-owner list.
    assert.notEqual(older.html_url, made.html_url);
    assert.deepEqual((await run(sys)).out, [
      `#12: proposed on #12, waiting on example-owner's 👍: ${made.html_url as string}`,
      '✓ state #30: example-owner has decided',
      `#12 is labeled needs-owner, waiting on example-owner's 👍 on ${made.html_url as string}`,
    ]);
    assert.deepEqual(posted(sys), []);
  });

  it("links, given a state, the slice's own waiting proposal too, or says how to post it", async () => {
    const g = owing();
    const { sys } = session(g);
    assert.deepEqual((await run(sys, 30)).out, [
      '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1',
      "#12 is labeled needs-owner, waiting on example-owner's 👍 on https://github.com/example-org/example-app/issues/12#issuecomment-1; ExampleBot proposes #12 with: process-rules propose 12",
    ]);
    const made = comment('Proposal: add #12', LATER, AGENT);
    g.comments.push(made);
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    assert.deepEqual((await run(sys, 30)).out, [
      '✓ state #30: example-owner has decided',
      `#12 is labeled needs-owner, waiting on example-owner's 👍 on ${made.html_url as string}`,
    ]);
    g.comments.pop();
    assert.deepEqual((await run(sys, 30)).out, [
      '✓ state #30: example-owner has decided',
      '#12 is labeled needs-owner; ExampleBot proposes #12 with: process-rules propose 12',
    ]);
  });

  it('still counts a proposal GitHub answered without its link as posted', async () => {
    const g = owing();
    g.states.pop();
    const { sys } = session(g);
    sys.route('POST', `${ISSUE}/comments`, { status: 201, json: null });
    assert.deepEqual((await run(sys)).out, ['✓ #12: proposed on #12', '#12 is labeled needs-owner']);
  });

  it("takes the label off once the owner's 👍 settles everything", async () => {
    const g = owing();
    g.states.pop();
    const made = comment('Proposal: add #12', LATER, AGENT);
    g.comments.push(made);
    g.thumbs.set(made.id as string, [thumb()]);
    const { sys } = session(g);
    assert.deepEqual((await run(sys)).out, ['✓ #12: example-owner has decided', '✓ #12: nothing waits on example-owner']);
    assert.ok(sys.requests.some((r) => r.method === 'DELETE'));
    sys.route('DELETE', `${ISSUE}/labels/needs-owner`, { status: 404, json: null });
    assert.equal((await run(sys)).code, 0);
    sys.route('DELETE', `${ISSUE}/labels/needs-owner`, { status: 403, json: null });
    await assert.rejects(run(sys), /cannot take needs-owner off #12 \(HTTP 403\)/);
  });

  it('says when the issue owes the owner nothing', async () => {
    assert.deepEqual(await run(session().sys), { code: 0, out: ['propose: #12 needs no decision from example-owner'], err: [] });
  });

  it('refuses a slice the work rules stop outright', async () => {
    const g = graph();
    g.timeline.splice(1, 1);
    assert.deepEqual(await run(session(g).sys), {
      code: 1,
      out: [],
      err: ['✗ work item #10 is not approved: example-owner adds the approved label before any slice starts', 'propose: refused by the work rules'],
    });
  });

  it('refuses a session with no token, or not working as the agent', async () => {
    const { sys } = session();
    sys.env = { GH_TOKEN: 'process-rules-no-agent-token' };
    assert.equal((await run(sys)).err[0], '✗ this session has no token; run process-rules doctor');
    sys.env = { GH_TOKEN: 'ghp_owner' };
    assert.equal((await run(sys)).err[0], "✗ propose posts as ExampleBot, but this session's token is refused");
    sys.acceptToken('ghp_owner', OWNER);
    assert.equal((await run(sys)).err[0], "✗ propose posts as ExampleBot, but this session's token is example-owner");
  });

  it('throws when GitHub will not take the comment or the label', async () => {
    const { sys } = session(owing());
    sys.route('POST', `${ISSUE}/comments`, { status: 403, json: null });
    await assert.rejects(run(sys), /cannot comment on #12 \(HTTP 403\)/);
    const other = session(owing()).sys;
    other.route('POST', `${ISSUE}/comments`, { status: 201, json: null });
    other.route('POST', `${ISSUE}/labels`, { status: 404, json: null });
    await assert.rejects(run(other), /cannot label #12 needs-owner \(HTTP 404\)/);
  });

  it('passes when the work rules are off', async () => {
    const { sys } = session();
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ ...JSON.parse(SETTINGS), features: ['identity'] }));
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /^propose: .*work-rules/);
  });
});

describe('with two owners and two agents', () => {
  const added = (): ReturnType<typeof graph> => {
    const g = graph();
    g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
    return g;
  };
  const dropped = (g = graph()): ReturnType<typeof graph> => {
    g.states.push({ number: 30, type: { name: 'State' }, state_reason: 'not_planned', closed_at: LATER, comments: [] });
    return g;
  };

  it("takes either owner's approval of the work item, and no one else's", async () => {
    const g = graph();
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: { login: 'second-owner' }, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: { login: AGENT_2 }, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), ['work item #10 was labeled approved by OtherBot, not example-owner or Second-Owner']);
    g.timeline.splice(1, 1);
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), ['work item #10 is not approved: example-owner or Second-Owner adds the approved label before any slice starts']);
  });

  it("names both owners and both agents in what a slice added after approval owes", async () => {
    assert.deepEqual(await problems(added().issue, [], {}, TEAM), [
      '#12 was added to work item #10 after its approval; example-owner or Second-Owner reacts 👍 on ExampleBot or OtherBot\'s proposal on #12, or adds a "Decision:" comment naming #12, or #12 links example-owner or Second-Owner\'s request for it on #10; ExampleBot or OtherBot proposes it with: process-rules propose 12',
    ]);
  });

  it("takes the second owner's Decision: comment, on the work item or the slice", async () => {
    const g = added();
    g.timeline.push(comment('Decision: add #12', LATEST, OWNER_2));
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
    const h = added();
    h.comments.push(comment('Decision: keep it', LATEST, OWNER_2));
    assert.deepEqual(await problems(h.issue, [], {}, TEAM), []);
    // Not an agent's, either one.
    const i = added();
    i.comments.push(comment('Decision: keep it', LATEST, AGENT_2));
    assert.equal((await problems(i.issue, [], {}, TEAM)).length, 1);
  });

  it("takes the second owner's request on the work item, which the slice links", async () => {
    const g = added();
    const request = { ...comment('Please add a slice for the thing', APPROVED, OWNER_2), id: 777 };
    g.timeline.push(request);
    g.issue.body = `${g.issue.body as string}\n\nAsked for in https://github.com/${SLUG}/issues/10#issuecomment-777`;
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
  });

  it("takes either owner's 👍 on either agent's proposal", async () => {
    for (const [agent, owner] of [[AGENT_2, OWNER], [AGENT, OWNER_2], [AGENT_2, 'SECOND-OWNER']] as const) {
      const g = added();
      const made = comment('Proposal: add #12 (Add the thing) to work item #10', LATER, agent);
      g.comments.push(made);
      g.thumbs.set(made.id as string, [thumb(LATEST, owner)]);
      assert.deepEqual(await problems(g.issue, [], {}, TEAM), [], `${owner} on ${agent}'s proposal`);
    }
    const g = added();
    const made = comment('Proposal: add #12', LATER, AGENT_2);
    g.comments.push(made);
    g.thumbs.set(made.id as string, [thumb(LATEST, AGENT)]);
    assert.equal((await problems(g.issue, [], {}, TEAM)).length, 1, "an agent's 👍 does not count");
  });

  it("takes the second owner's Decision: or 👍 on a dropped state", async () => {
    const g = dropped();
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), [
      'state #30 was closed as not planned after approval; example-owner or Second-Owner reacts 👍 on ExampleBot or OtherBot\'s proposal for it on #12, or adds a "Decision:" comment to it; ExampleBot or OtherBot proposes it with: process-rules propose 30',
    ]);
    g.comments.push(comment('Decision: drop #30', LATEST, OWNER_2));
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
    const h = dropped();
    const made = comment('Proposal: drop state #30 (Empty list)', LATER, AGENT_2);
    h.comments.push(made);
    h.thumbs.set(made.id as string, [thumb(LATEST, OWNER_2)]);
    assert.deepEqual(await problems(h.issue, [], {}, TEAM), []);
  });

  it("holds the second agent's pull request to the work rules, and leaves the second owner's alone", async () => {
    const EVENT = '/tmp/event.json';
    const actions = (login: string, body: string | null): FakeSys => {
      const sys = new FakeSys();
      sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
      sys.files.set(`${ROOT}/.github/process-rules.json`, TEAM_SETTINGS);
      sys.files.set(EVENT, JSON.stringify({ pull_request: { number: 40, body, user: { login }, head: { ref: 'work' } } }));
      github(sys, graph().issue);
      return sys;
    };
    const check = async (sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> => {
      const { io, out, err } = capture();
      return { code: await prWorkRules(sys, io), out, err };
    };
    assert.deepEqual(await check(actions(AGENT_2, 'Slice: #12')), { code: 0, out: ['✓ pr-work-rules: #40 builds slice #12, which may be built'], err: [] });
    assert.equal((await check(actions('otherbot', null))).code, 1);
    assert.deepEqual((await check(actions(OWNER_2, null))).out, ['pr-work-rules: #40 is by Second-Owner, not an agent; the work rules bind agent pull requests']);
  });

  it('lets either agent push, and refuses an owner', async () => {
    const push = async (login: string): Promise<{ code: number; err: string[] }> => {
      const sys = new FakeSys();
      sys.files.set(`${ROOT}/.github/process-rules.json`, TEAM_SETTINGS);
      sys.env = { PROCESS_RULES_AGENT: login, GH_TOKEN: 'ghp_good' };
      sys.execOverride = (call) => (call.args[0] === 'log' ? { code: 0, stdout: 'Slice: #12\n', stderr: '' } : undefined);
      github(sys, graph().issue);
      sys.acceptToken('ghp_good', login);
      const { io, err } = capture();
      return { code: await prePush(sys, io, `refs/heads/work ${'a'.repeat(40)} refs/heads/work ${'b'.repeat(40)}\n`, 'https://github.com/example-org/example-app.git'), err };
    };
    assert.deepEqual(await push(AGENT), { code: 0, err: [] });
    assert.deepEqual(await push(AGENT_2), { code: 0, err: [] });
    assert.deepEqual((await push(OWNER_2)).err, [
      '✗ this push would reach GitHub as Second-Owner, not ExampleBot or OtherBot; agent sessions push only as ExampleBot or OtherBot: this session was not given the agent identity, which sends GitHub over HTTPS; tell the owner',
      'pre-push: refused; an agent session pushes to GitHub only as ExampleBot or OtherBot',
    ]);
  });

  it('proposes as the second agent, asking both owners', async () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.github/process-rules.json`, TEAM_SETTINGS);
    sys.env = { PROCESS_RULES_AGENT: AGENT_2, GH_TOKEN: 'ghp_good' };
    sys.acceptToken('ghp_good', AGENT_2);
    github(sys, added().issue);
    sys.route('POST', `/repos/${SLUG}/issues/12/comments`, { status: 201, json: { html_url: `https://github.com/${SLUG}/issues/12#issuecomment-9` } });
    sys.route('POST', `/repos/${SLUG}/issues/12/labels`, { status: 200, json: [] });
    const { io, out } = capture();
    assert.equal(await propose(sys, io, 12), 0);
    assert.equal(out.at(-1), `#12 is labeled needs-owner, waiting on example-owner or Second-Owner's 👍 on https://github.com/${SLUG}/issues/12#issuecomment-9`);
    const body = (sys.requests.find((r) => r.method === 'POST' && r.url.endsWith('/comments'))?.body as { body: string }).body;
    assert.match(body, /\n\n@example-owner or @Second-Owner: react 👍 to this comment to approve it, or comment "Decision:"\.$/);
    sys.acceptToken('ghp_good', OWNER_2);
    const refused = capture();
    assert.equal(await propose(sys, refused.io, 12), 1);
    assert.equal(refused.err[0], "✗ propose posts as ExampleBot or OtherBot, but this session's token is Second-Owner");
  });
});
