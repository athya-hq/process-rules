import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { designLibrary, frameProblem, prDesign } from './design.ts';
import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';

const FIGMA = 'https://api.figma.com/v1';
const LINK = 'https://www.figma.com/design/FILE1/Screens?node-id=12-34&t=x';
const KEYS = new Set(['lib-button']);
const box = (width: number, height: number) => ({ width, height });

/** A frame in Figma: children inside a 100×100 frame, with the components they instance. */
function frameReply(children: Record<string, unknown>[], type = 'FRAME'): Record<string, unknown> {
  return {
    nodes: {
      '12:34': {
        document: { id: '12:34', type, absoluteBoundingBox: box(100, 100), children },
        components: { 'c:1': { key: 'lib-button' }, 'c:2': { key: 'local-thing' }, 'c:3': {} },
      },
    },
  };
}

function figma(sys: FakeSys, reply: unknown, status = 200): void {
  sys.route('GET', `${FIGMA}/files/FILE1/nodes?ids=12%3A34`, { status, json: reply });
}

async function problem(reply: unknown, link = LINK): Promise<string | undefined> {
  const sys = new FakeSys();
  figma(sys, reply);
  return frameProblem(sys, 'figd_tok', link, KEYS);
}

const button = { id: '1:1', type: 'INSTANCE', componentId: 'c:1', absoluteBoundingBox: box(20, 10) };

describe('frameProblem', () => {
  it('passes a frame built from the library', async () => {
    assert.equal(await problem(frameReply([{ id: '1:0', type: 'GROUP', children: [button] }])), undefined);
  });

  it('asks Figma with the token in its header', async () => {
    const sys = new FakeSys();
    figma(sys, frameReply([button]));
    await frameProblem(sys, 'figd_tok', LINK, KEYS);
    assert.deepEqual(sys.requests[0]?.headers, { 'x-figma-token': 'figd_tok' });
  });

  for (const [name, reply, expected] of [
    ['a frame with no library component', frameReply([{ id: '1:2', type: 'INSTANCE', componentId: 'c:2' }, { id: '1:3', type: 'INSTANCE', componentId: 'c:3' }, { id: '1:4', type: 'INSTANCE', componentId: 'c:9' }, { id: '1:5', type: 'TEXT' }]), 'links a frame that uses no component from the design library'],
    ['a captured screenshot', frameReply([button, { id: '1:6', type: 'RECTANGLE', fills: [{ type: 'IMAGE' }], absoluteBoundingBox: box(100, 80) }]), 'links a captured image, not a frame built from the library'],
    ['a link to something other than a frame', frameReply([button], 'TEXT'), 'links a TEXT, not a frame'],
    ['a frame that does not exist', { nodes: { '12:34': null } }, 'links frame 12:34, which does not exist in Figma file FILE1'],
    ['a reply with no nodes', {}, 'links frame 12:34, which does not exist in Figma file FILE1'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      assert.equal(await problem(reply), expected);
    });
  }

  it('lets small, hidden or unsized images be', async () => {
    const images = [
      { id: '2:1', type: 'RECTANGLE', fills: [{ type: 'IMAGE' }], absoluteBoundingBox: box(10, 10) },
      { id: '2:2', type: 'RECTANGLE', fills: [{ type: 'IMAGE', visible: false }], absoluteBoundingBox: box(100, 100) },
      { id: '2:3', type: 'RECTANGLE', fills: [{ type: 'SOLID' }], absoluteBoundingBox: box(100, 100) },
      { id: '2:4', type: 'RECTANGLE', fills: [{ type: 'IMAGE' }], absoluteBoundingBox: null },
    ];
    assert.equal(await problem(frameReply([button, ...images])), undefined);
  });

  it('finds no capture in a frame Figma gives no size', async () => {
    const reply = frameReply([button, { id: '3:1', type: 'RECTANGLE', fills: [{ type: 'IMAGE' }], absoluteBoundingBox: box(5, 5) }]);
    ((reply.nodes as Record<string, { document: Record<string, unknown> }>)['12:34'] as { document: Record<string, unknown> }).document.absoluteBoundingBox = undefined;
    assert.equal(await problem(reply), undefined);
  });

  it('refuses a state with no Figma frame link', async () => {
    assert.equal(await problem(frameReply([button]), 'see https://figma.com/file/FILE1/x'), 'links no Figma frame (a figma.com/design link with node-id)');
  });

  it('reads older file links and colon ids', async () => {
    assert.equal(await problem(frameReply([button]), 'https://figma.com/file/FILE1/S?type=design&node-id=12:34'), undefined);
  });

  it('throws when Figma refuses', async () => {
    const sys = new FakeSys();
    figma(sys, null, 403);
    await assert.rejects(frameProblem(sys, 'figd_tok', LINK, KEYS), /Figma refused \/files\/FILE1\/nodes\?ids=12%3A34 \(HTTP 403\)/);
  });
});

describe('designLibrary', () => {
  it('reads the library from the FIGMA_LIBRARY secret, or none', () => {
    const sys = new FakeSys();
    assert.deepEqual(designLibrary(sys, ROOT), { warnings: [] });
    sys.env.FIGMA_LIBRARY = ' LIB2 ';
    assert.deepEqual(designLibrary(sys, ROOT), { library: 'LIB2', warnings: [] });
    sys.env.FIGMA_LIBRARY = 'a/b';
    assert.throws(() => designLibrary(sys, ROOT), /the FIGMA_LIBRARY secret must be the file key/);
  });

  it('still reads a library the settings name, with a warning, and the secret over it', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, figma: { library: 'LIB1' } }));
    assert.deepEqual(designLibrary(sys, ROOT), {
      library: 'LIB1',
      warnings: ['.github/process-rules.json names the Figma library; move it to the FIGMA_LIBRARY Actions secret and take "figma" out of the settings'],
    });
    sys.env.FIGMA_LIBRARY = 'LIB2';
    assert.deepEqual(designLibrary(sys, ROOT), { library: 'LIB2', warnings: [] });
    delete sys.env.FIGMA_LIBRARY;
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ figma: { library: 'a/b' } }));
    assert.throws(() => designLibrary(sys, ROOT), /"figma.library" must be the file key/);
  });
});

describe('prDesign', () => {
  const EVENT = '/tmp/event.json';
  const SETTINGS = JSON.stringify({ owner: 'example-owner', agent: AGENT });
  const state = (number: number, body: string, extra: Record<string, unknown> = {}) => ({ number, issueType: { name: 'State' }, stateReason: null, body, ...extra });

  function actions(states: unknown[] | null, user = AGENT, body: string | null = 'Slice: #12'): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: 'example-org/example-app', GH_TOKEN: 'ghs_run', FIGMA_TOKEN: 'figd_tok', FIGMA_LIBRARY: 'LIB1' };
    sys.files.set(`${ROOT}/.github/process-rules.json`, SETTINGS);
    sys.files.set(EVENT, JSON.stringify({ pull_request: { number: 40, body, user: { login: user } } }));
    sys.route('POST', '/graphql', { status: 200, json: { data: { repository: { issue: states ? { subIssues: { nodes: states } } : null } } } });
    sys.route('GET', `${FIGMA}/files/LIB1/components`, { status: 200, json: { meta: { components: [{ key: 'lib-button' }, {}] } } });
    figma(sys, frameReply([button]));
    return sys;
  }
  async function check(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await prDesign(sys, io), out, err };
  }

  it("passes when each of the slice's states links a library frame", async () => {
    const sys = actions([
      state(30, `Frame: ${LINK}`),
      state(31, 'dropped', { stateReason: 'NOT_PLANNED' }),
      { number: 32, issueType: { name: 'Brief' }, stateReason: null, body: '' },
    ]);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-design: 1 state of #12, each a frame built from the design library'], err: [] });
  });

  it('counts states in the plural', async () => {
    const sys = actions([state(30, LINK), state(33, LINK)]);
    assert.deepEqual((await check(sys)).out, ['✓ pr-design: 2 states of #12, each a frame built from the design library']);
  });

  it('refuses a state whose frame is not built from the library', async () => {
    const sys = actions([state(30, LINK), state(34, 'no link yet')]);
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: ['✗ state #34 links no Figma frame (a figma.com/design link with node-id)', 'pr-design: refused by the design check'],
    });
  });

  it('is off, and says so, without a FIGMA_LIBRARY secret', async () => {
    const sys = actions([]);
    delete sys.env.FIGMA_LIBRARY;
    assert.deepEqual((await check(sys)).out, ['pr-design: no FIGMA_LIBRARY secret names the Figma design library; the design check is off until the owner adds one']);
  });

  it('warns about older settings: the design feature, and a committed library', async () => {
    const sys = actions([state(30, LINK)]);
    delete sys.env.FIGMA_LIBRARY;
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'], figma: { library: 'LIB1' } }));
    assert.deepEqual((await check(sys)).out, [
      '::warning::.github/process-rules.json lists "design", which is now named "figma"; run process-rules onboard to rename it',
      '::warning::.github/process-rules.json names the Figma library; move it to the FIGMA_LIBRARY Actions secret and take "figma" out of the settings',
      '✓ pr-design: 1 state of #12, each a frame built from the design library',
    ]);
  });

  it('is off when the figma feature is', async () => {
    const sys = actions([]);
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    assert.deepEqual((await check(sys)).out, ['pr-design: figma is off in .github/process-rules.json; nothing to check']);
  });

  it('is off, and says so, without a Figma token', async () => {
    const sys = actions([]);
    delete sys.env.FIGMA_TOKEN;
    assert.deepEqual((await check(sys)).out, ['pr-design: no FIGMA_TOKEN secret; the design check is off until the owner adds one']);
  });

  for (const [name, sys] of [
    ["the owner's pull request", () => actions([], 'example-owner')],
    ['a pull request naming no slice', () => actions([], AGENT, null)],
  ] as const) {
    it(`skips ${name}`, async () => {
      assert.deepEqual((await check(sys())).out, ['pr-design: not an agent pull request naming a slice; nothing to check']);
    });
  }

  it('skips events that are not pull requests', async () => {
    const sys = actions([]);
    sys.files.set(EVENT, '{}');
    assert.equal((await check(sys)).code, 0);
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(check(new FakeSys()), /pr-design runs in GitHub Actions/);
  });

  it("checks the slice's states past the first page", async () => {
    const sys = actions(null);
    const first = Array.from({ length: 100 }, (_, n) => state(100 + n, LINK));
    sys.route('POST', '/graphql', () => {
      const { after } = (sys.requests.at(-1)?.body as { variables: { after: string | null } }).variables;
      const subIssues = after === null
        ? { nodes: first, pageInfo: { hasNextPage: true, endCursor: 'p2' } }
        : { nodes: [state(250, 'no link yet')], pageInfo: { hasNextPage: false, endCursor: null } };
      return { status: 200, json: { data: { repository: { issue: { subIssues } } } } };
    });
    assert.deepEqual((await check(sys)).err, ['✗ state #250 links no Figma frame (a figma.com/design link with node-id)', 'pr-design: refused by the design check']);
    const cursors = sys.requests.filter((request) => request.url.endsWith('/graphql')).map((request) => (request.body as { variables: { after: string | null } }).variables.after);
    assert.deepEqual(cursors, [null, 'p2']);
  });

  it('throws when GitHub will not list the states', async () => {
    await assert.rejects(check(actions(null)), /cannot read the states of #12 \(HTTP 200\)/);
  });

  it('reads a library with no published components as none', async () => {
    const sys = actions([state(30, LINK)]);
    sys.route('GET', `${FIGMA}/files/LIB1/components`, { status: 200, json: {} });
    assert.equal((await check(sys)).err[0], '✗ state #30 links a frame that uses no component from the design library');
  });
});
