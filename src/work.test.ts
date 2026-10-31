import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, SETTINGS, capture } from './fake.test.ts';
import { prePush, prWorkRules, propose, section, sliceProblems, slicesNamed } from './work.ts';

const SLUG = 'example-org/example-app';
const OWNER = 'example-owner';
const ACCOUNTS = { owners: [OWNER], agents: [AGENT] };
const T0 = '2026-10-01T00:00:00Z';
const APPROVED = '2026-10-02T00:00:00Z';
const LATER = '2026-10-03T00:00:00Z';
const LATEST = '2026-10-04T00:00:00Z';

type Node = Record<string, unknown>;

/** Slice #12 under work item #10, approved by the owner, with nothing else. */
function graph(): { issue: Node; timeline: Node[]; states: Node[]; comments: Node[]; thumbs: Map<string, Node[]> } {
  const timeline: Node[] = [
    { event: 'sub_issue_added', created_at: T0, sub_issue: { number: 12 } },
    { event: 'labeled', created_at: APPROVED, actor: { login: OWNER }, label: { name: 'approved' } },
  ];
  const states: Node[] = [];
  const comments: Node[] = [];
  const issue: Node = {
    number: 12,
    title: 'Add the thing',
    body: 'Slice P-01 of #10.\n\n**You will see:** the thing.\n- on every page\n\n**Why:** it is asked for.\n\n**Needs:** —',
    type: { name: 'Slice' },
    comments,
    parent: { number: 10, type: { name: 'Work item' } },
    timeline,
    states,
    thumbs: new Map<string, Node[]>(),
  };
  return { issue, timeline, states, comments, thumbs: issue.thumbs as Map<string, Node[]> };
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
  const parent = issue.parent as Node | null;
  const states = (issue.states as Node[]).map((state): Node => ({ ...state, url: `${ISSUES}/${state.number}` }));
  // As a workflow's GITHUB_TOKEN reads a private repository: no parent_issue_url, the parent from its endpoint alone.
  if (path === '/12') return { status: 200, json: { ...issue, url: `${ISSUES}/12`, parent_issue_url: null } };
  if (path === '/12/parent') {
    return parent ? { status: 200, json: { ...parent, url: `${ISSUES}/10` } } : { status: 404, json: { message: 'No parent issue found' } };
  }
  if (path === '/10/timeline') return page(issue.timeline as Node[]);
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
}

let ids = 0;
const comment = (body: string, created_at = LATEST, login = OWNER, edited: string | null = null): Node => ({
  event: 'commented',
  id: `IC_${++ids}`,
  user: { login },
  body,
  created_at,
  updated_at: edited ?? created_at,
});
const thumb = (created_at = LATEST, login = OWNER): Node => ({ user: { login }, created_at });

async function problems(issue: Node | null, pulls: Node[] = [], mine: { pull?: number; branch?: string } = {}, accounts = ACCOUNTS): Promise<string[]> {
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
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      assert.deepEqual(await problems(g.issue), []);
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
      files(sys, [{ filename: '.github/process-rules.json', status: 'modified' }, { filename: '.claude/settings.json', status: 'added' }, { filename: '.github/workflows/process-rules.yml' }, { filename: 'CODEOWNERS' }]);
      assert.deepEqual(await check(sys), { code: 0, out: ["✓ pr-work-rules: #42 is onboard's, changing only the files onboard writes, so it names no slice"], err: [] });
      assert.equal(sys.requests[0]?.token, 'ghs_run');
    });

    for (const [name, list] of [
      ['changes another file', [{ filename: '.github/process-rules.json' }, { filename: 'src/app.ts' }]],
      ['moves another file into one onboard writes', [{ filename: 'CODEOWNERS', previous_filename: 'src/owners' }]],
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
});

describe('propose', () => {
  const ISSUE = `/repos/${SLUG}/issues/12`;
  /** An agent session, slice #12 added after approval, and state #30 of it dropped after approval. */
  function session(g = graph()): { sys: FakeSys; g: ReturnType<typeof graph> } {
    const sys = new FakeSys();
    sys.env = { PROCESS_RULES_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
    sys.acceptToken('ghp_good', AGENT);
    github(sys, g.issue);
    sys.route('POST', `${ISSUE}/comments`, { status: 201, json: { html_url: 'https://github.com/example-org/example-app/issues/12#issuecomment-1' } });
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
        '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1',
        "#12 is labeled needs-owner, so it shows in example-owner's Needs you view",
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

  it('posts nothing twice, and keeps the label while the owner has not decided', async () => {
    const g = owing();
    g.comments.push(comment('Proposal: add #12', LATER, AGENT));
    // On the slice, any Decision: also settles its addition.
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    const { sys } = session(g);
    assert.deepEqual((await run(sys)).out, [
      "#12: proposed on #12, waiting on example-owner's 👍",
      '✓ state #30: example-owner has decided',
      "#12 is labeled needs-owner, so it shows in example-owner's Needs you view",
    ]);
    assert.deepEqual(posted(sys), []);
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
    sys.route('POST', `/repos/${SLUG}/issues/12/comments`, { status: 201, json: {} });
    sys.route('POST', `/repos/${SLUG}/issues/12/labels`, { status: 200, json: [] });
    const { io, out } = capture();
    assert.equal(await propose(sys, io, 12), 0);
    assert.equal(out.at(-1), "#12 is labeled needs-owner, so it shows in example-owner or Second-Owner's Needs you view");
    const body = (sys.requests.find((r) => r.method === 'POST' && r.url.endsWith('/comments'))?.body as { body: string }).body;
    assert.match(body, /\n\n@example-owner or @Second-Owner: react 👍 to this comment to approve it, or comment "Decision:"\.$/);
    sys.acceptToken('ghp_good', OWNER_2);
    const refused = capture();
    assert.equal(await propose(sys, refused.io, 12), 1);
    assert.equal(refused.err[0], "✗ propose posts as ExampleBot or OtherBot, but this session's token is Second-Owner");
  });
});
