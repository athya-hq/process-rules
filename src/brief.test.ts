import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CARRYING_SECTIONS,
  FIELDS_FENCE,
  addToProject,
  briefToIssue,
  deletedSince,
  isCommitSha,
  issueToBrief,
  judgeBrief,
  lintBrief,
  lintDraft,
  loadYaml,
  openBrief,
  readBrief,
  readFrontmatter,
  repoPath,
  saysFixes,
  splitFrontmatter,
  splitSections,
  type BriefIssue,
  type LintContext,
} from './brief.ts';
import { FakeSys, draft } from './fake.test.ts';

const yaml = await loadYaml();
const REPO = '/repos/example-org/example-app';
const SHA = 'c'.repeat(40);

const context = (over: Partial<LintContext> = {}): LintContext => ({
  yaml,
  pathExists: (path) => path === 'tools/lint.sh' || path === 'src/a.ts',
  pathDeletedSince: () => false,
  changedFiles: ['src/a.ts'],
  ...over,
});

describe('repoPath and isCommitSha', () => {
  it('spells a path as git does, and refuses one outside', () => {
    assert.equal(repoPath(' ./a//b/../c\\d '), 'a/c/d');
    assert.equal(repoPath('/etc/passwd'), null);
    assert.equal(repoPath('../x'), null);
    assert.equal(repoPath('.'), null);
  });

  it('tells a commit id from a ref', () => {
    assert.equal(isCommitSha('abc1234'), true);
    assert.equal(isCommitSha('main'), false);
    assert.equal(isCommitSha('abc12'), false);
  });
});

describe('splitFrontmatter and splitSections', () => {
  it('splits the frontmatter, or finds none', () => {
    assert.deepEqual(splitFrontmatter('---\na: 1\n---\nbody'), { frontmatter: 'a: 1', body: 'body' });
    assert.equal(splitFrontmatter('no front'), null);
    assert.equal(splitFrontmatter('---\nunclosed'), null);
  });

  it('reads sections, never a heading inside a fence of either marker', () => {
    const sections = splitSections(['before', '##   Spaced   heading', 'one', '~~~', '## not a section', '~~~', '```js```', '## Two', '````', '## inside', '```', 'still inside', '````', ''].join('\n'));
    assert.deepEqual([...sections.keys()], ['## Spaced heading', '## Two']);
    assert.match(sections.get('## Spaced heading') ?? '', /## not a section/);
    assert.match(sections.get('## Two') ?? '', /still inside/);
  });

  // The forms athya_mono's differential suite compared against CommonMark.
  for (const [name, body, keys] of [
    ['CRLF line endings', '## A\r\none\r\n## B\r\ntwo', ['## A', '## B']],
    ['a tab after the hashes', '##\tA\nx', ['## A']],
    ['lines that only look like headings', '##a\n### c\n# d\n## A', ['## A']],
    ['a fence indented three spaces', '## A\n   ```\n## no\n   ```\n## B', ['## A', '## B']],
    ['a shorter closer, which does not close', '## A\n````\n```\n## no\n````\n## B', ['## A', '## B']],
    ['a closer of the other character, which does not close', '## A\n```\n~~~\n## no\n```\n## B', ['## A', '## B']],
    ['a closer with trailing text, which does not close', '## A\n```\n``` x\n## no\n```\n## B', ['## A', '## B']],
    ['a fence never closed', '## A\n```\n## no', ['## A']],
    ['a repeated heading, the last body kept', '## A\none\n## A\ntwo', ['## A']],
  ] as const) {
    it(`reads ${name}`, () => assert.deepEqual([...splitSections(body).keys()], keys));
  }

  it('keeps the last body of a repeated heading', () => assert.equal(splitSections('## A\none\n## A\ntwo').get('## A'), 'two'));
});

describe('readFrontmatter', () => {
  it('reads text and lists, keeping YAML 1.2 words as written', () => {
    assert.deepEqual(readFrontmatter('blocking: no\nwhen: 2026-11-14\nempty:\nlist: [a, "", b]', yaml), {
      fields: { blocking: 'no', when: '2026-11-14', empty: '', list: ['a', 'b'] },
      nonScalar: [],
    });
    assert.deepEqual(readFrontmatter('', yaml), { fields: {}, nonScalar: [] });
  });

  it('names a mapping, which is no answer, and refuses what is not a mapping', () => {
    assert.deepEqual(readFrontmatter('a:\n  b: 1\nc: [{d: 1}]', yaml)?.nonScalar, ['a', 'c']);
    assert.equal(readFrontmatter('- a', yaml), null);
    assert.equal(readFrontmatter('a: [', yaml), null);
  });
});

describe('lintBrief', () => {
  it('passes a whole brief', () => {
    const lint = lintBrief(draft(), context());
    assert.deepEqual(lint.problems, []);
    assert.equal(lint.fields?.blocking, false);
    assert.deepEqual(lint.fields?.blamedPaths, ['tools/lint.sh']);
  });

  it('refuses a draft with no frontmatter, naming the template', () => {
    assert.deepEqual(lintBrief('# x', context({ template: 'docs/brief.md' })).problems, ['no YAML frontmatter; start the file from docs/brief.md']);
    assert.deepEqual(lintBrief('# x', context()).problems, ['no YAML frontmatter']);
    assert.deepEqual(lintBrief('---\na: [\n---\n', context()).problems, ['frontmatter is not valid YAML']);
    assert.match(lintBrief('---\nslug:\n  a: 1\n---\n', context()).problems[0] ?? '', /`slug` is a mapping/);
  });

  for (const [name, fields, problem] of [
    ['empty fields', { slug: '', title: '', 'discovered-on': '' }, /`slug` is empty.*`title` is empty.*`discovered-on` is empty/],
    ['an unreadable blocking', { blocking: 'maybe' }, /`blocking` must be yes or no \(got "maybe"\)/],
    ['an unknown status', { status: 'done' }, /`status` must be one of open, resolved, rejected/],
    ['resolved with no commit', { status: 'resolved' }, /needs a `resolved-by:` commit id/],
    ['resolved by a ref', { status: 'resolved', 'resolved-by': 'main' }, /is a ref, not a commit id/],
    ['rejected with no note', { status: 'rejected' }, /needs a `resolution-note:`/],
    ['no blamed paths', { 'blamed-paths': '' }, /`blamed-paths` is empty/],
    ['a path outside', { 'blamed-paths': ' /etc/x' }, /not a path inside this repository: \/etc\/x/],
    ['a missing path', { 'blamed-paths': ' gone.sh' }, /does not exist in this tree: gone.sh$/],
    ['a path the branch changed', { 'blamed-paths': ' src/a.ts' }, /in this branch's own diff: src\/a.ts/],
  ] as const) {
    it(`refuses ${name}`, () => assert.match(lintBrief(draft(fields), context()).problems.join('; '), problem));
  }

  it('lets a carrying session blame its own file, owing two more sections', () => {
    const carrying = lintBrief(draft({ 'blamed-paths': ' src/a.ts' }), context({ disposition: 'carrying' }));
    assert.deepEqual(carrying.problems, CARRYING_SECTIONS.map((heading) => `missing section: ${heading}`));
    const whole = lintBrief(draft({ 'blamed-paths': ' src/a.ts' }, '## What I verified\nIt passes.\n## Why I did not hand off\nOne line.'), context({ disposition: 'carrying' }));
    assert.deepEqual(whole.problems, []);
  });

  it('lets a resolved brief outlive a file its fix deleted, and a rejected one any file', () => {
    const gone = { status: 'resolved', 'resolved-by': SHA, 'blamed-paths': ' gone.sh' };
    assert.deepEqual(lintBrief(draft(gone), context({ pathDeletedSince: (sha, path) => sha === SHA && path === 'gone.sh' })).problems, []);
    assert.match(lintBrief(draft(gone), context()).problems.join(), /ccccccc or a later commit in this history did not remove it/);
    assert.deepEqual(lintBrief(draft({ status: 'rejected', 'resolution-note': 'not a bug', 'blamed-paths': ' gone.sh' }), context()).problems, []);
  });

  it('refuses empty or missing sections, and evidence that is only described', () => {
    const empty = draft().replace('Run it on main.', '').replace('## Sequencing\nBefore the next push.', '');
    assert.deepEqual(lintBrief(empty, context()).problems, ['section is empty: ## What the receiving session must verify first', 'missing section: ## Sequencing']);
    const described = draft().replace(/```\n\$ pnpm lint\n.*\n```/, 'It failed, see ```log```.');
    assert.deepEqual(lintBrief(described, context()).problems, ['## What happened holds no fenced evidence: paste the command and its output, not a description of it']);
    const quoted = draft().replace(/```\n\$ pnpm lint\n.*\n```/, '> ~~~\n> out\n> ~~~');
    assert.deepEqual(lintBrief(quoted, context()).problems, []);
    const twice = draft().replace(/```\n\$ pnpm lint\n.*\n```/, ' >  > ```sh\n >  > out\n >  > ```');
    assert.deepEqual(lintBrief(twice, context()).problems, []);
    assert.deepEqual(lintBrief(draft().replace(/\n/g, '\r\n'), context()).problems, []);
  });
});

describe('deletedSince', () => {
  const probe = (at: string[], ancestor: boolean) => ({ existsAt: (rev: string) => at.includes(rev), isAncestor: () => ancestor });
  it('is true when the path was there at the commit or its parent, and the commit is in this history', () => {
    assert.equal(deletedSince(probe(['s^'], true), 's', 'p'), true);
    assert.equal(deletedSince(probe(['s'], true), 's', 'p'), true);
    assert.equal(deletedSince(probe([], true), 's', 'p'), false);
    assert.equal(deletedSince(probe(['s'], false), 's', 'p'), false);
  });
});

describe('briefToIssue and issueToBrief', () => {
  it('moves the fields into a fenced block without the state keys, and back as open', () => {
    const issue = briefToIssue(draft({ 'resolved-by': SHA }), 'T');
    assert.equal(issue.title, 'T');
    assert.ok(issue.body.startsWith(`${FIELDS_FENCE}\nslug: flaky-lint\n`));
    assert.ok(!/^(status|resolved-by|#)/m.test(issue.body.split('```\n## ')[0] ?? ''));
    const back = issueToBrief(issue.body.replace(/\n/g, '\r\n')) ?? '';
    assert.deepEqual(lintBrief(back, context()).problems, []);
    assert.match(back, /\nstatus: open\n---\n/);
  });

  it('reads no brief from a body not opened as one', () => {
    assert.equal(issueToBrief('text'), null);
    assert.equal(issueToBrief(`${FIELDS_FENCE}\nunclosed`), null);
    assert.deepEqual(briefToIssue('no front', 'T').body, `${FIELDS_FENCE}\n\n\`\`\`\nno front`);
  });
});

describe('saysFixes', () => {
  it("reads GitHub's closing keywords for the bare number only", () => {
    assert.equal(saysFixes('Fixes #12', 12), true);
    assert.equal(saysFixes('closed: #12.', 12), true);
    assert.equal(saysFixes('resolves #123', 12), false);
    assert.equal(saysFixes('fixes other/repo#12', 12), false);
    assert.equal(saysFixes('see #12', 12), false);
  });
});

describe('judgeBrief', () => {
  const issue = (over: Partial<BriefIssue> = {}): BriefIssue => ({
    number: 9,
    state: 'OPEN',
    stateReason: null,
    type: 'Brief',
    body: briefToIssue(draft(), 'T').body,
    closingSha: null,
    ...over,
  });
  const judge = (one: BriefIssue | null, disposition: 'handed-off' | 'carrying' = 'handed-off', branch = 'feature/a', ancestor = true) =>
    judgeBrief('#9', one, { branch, disposition, lint: context(), isAncestorOfHead: () => ancestor });
  const blocking = briefToIssue(draft({ blocking: 'yes' }), 'T').body;

  it('passes an open brief that blocks nothing, and a carrying one', () => {
    assert.deepEqual(judge(issue()), { ok: true });
    assert.deepEqual(judge(issue({ body: blocking }), 'carrying'), { ok: false, reason: 'brief-invalid', detail: `#9: ${CARRYING_SECTIONS.map((h) => `missing section: ${h}`).join('; ')}` });
  });

  for (const [name, one, reason, detail] of [
    ['an issue it cannot read', null, 'brief-unreadable', /could not be read from GitHub/],
    ['an issue of another type', issue({ type: 'Bug' }), 'brief-not-brief', /not a Brief issue \(type: Bug\)/],
    ['an issue of no type', issue({ type: null }), 'brief-not-brief', /type: none/],
    ['a body with no fields block', issue({ body: 'hand-written' }), 'brief-not-brief', /no fields block/],
    ['a brief that does not lint', issue({ body: briefToIssue(draft({ blocking: 'maybe' }), 'T').body }), 'brief-invalid', /`blocking` must be yes or no/],
    ['an open blocking brief', issue({ body: blocking }), 'handoff-not-landed', /blocking and still open/],
    ['a blocking brief closed by hand', issue({ body: blocking, state: 'CLOSED', stateReason: 'completed' }), 'handoff-not-landed', /closed \(completed\) by no merged pull request/],
    ['a blocking brief closed with no reason', issue({ body: blocking, state: 'CLOSED' }), 'handoff-not-landed', /closed \(no reason\)/],
  ] as const) {
    it(`refuses ${name}`, () => {
      const verdict = judge(one);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) {
        assert.equal(verdict.reason, reason);
        assert.match(verdict.detail, detail);
      }
    });
  }

  it('refuses a brief found on another branch', () => {
    assert.deepEqual(judge(issue(), 'handed-off', 'feature/b'), {
      ok: false,
      reason: 'brief-other-branch',
      detail: '#9 was discovered on "feature/a", not this branch "feature/b"; an older brief cannot answer for this push, so open one here',
    });
  });

  it('releases a blocking brief closed as not planned, or by a fix in this history', () => {
    const closed = { body: blocking, state: 'CLOSED' as const };
    assert.deepEqual(judge(issue({ ...closed, stateReason: 'not_planned', body: briefToIssue(draft({ blocking: 'yes', 'blamed-paths': ' gone.sh' }), 'T').body })), { ok: true });
    assert.deepEqual(judge(issue({ ...closed, stateReason: 'completed', closingSha: SHA })), { ok: true });
    assert.match(JSON.stringify(judge(issue({ ...closed, stateReason: 'completed', closingSha: SHA }), 'handed-off', 'feature/a', false)), /closed by ccccccc, which is not in this branch's history/);
  });
});

describe('lintDraft', () => {
  it('passes an open draft from this branch as an issue', () => {
    const linted = lintDraft(draft(), 'feature/a', context());
    assert.equal(linted.ok, true);
    if (linted.ok) assert.equal(linted.draft.title, 'The lint stage fails on a file this branch never touched');
  });

  it('refuses one not open, or found elsewhere, or with no frontmatter', () => {
    assert.deepEqual(lintDraft(draft({ status: 'rejected', 'resolution-note': 'n' }), 'feature/b', context()), {
      ok: false,
      problems: ['a new brief is `status: open`', '`discovered-on: feature/a` must be this branch, feature/b'],
    });
    assert.deepEqual(lintDraft('x', 'feature/a', context()), { ok: false, problems: ['no YAML frontmatter'] });
  });
});

describe('openBrief and addToProject', () => {
  it('opens a Brief issue and says which', async () => {
    const sys = new FakeSys().route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'https://github.com/x/9' } });
    assert.deepEqual(await openBrief(sys, 't', 'example-org/example-app', { title: 'T', body: 'B' }), { number: 9, id: 900, url: 'https://github.com/x/9' });
    assert.deepEqual(sys.requests.at(-1)?.body, { title: 'T', body: 'B', type: 'Brief' });
  });

  it('refuses when GitHub refuses or does not say which', async () => {
    const refused = new FakeSys().route('POST', `${REPO}/issues`, { status: 422, json: { message: 'type not found' } });
    await assert.rejects(openBrief(refused, 't', 'example-org/example-app', { title: 'T', body: 'B' }), /refused to open the Brief issue \(HTTP 422: type not found\)/);
    const silent = new FakeSys().route('POST', `${REPO}/issues`, { status: 201, json: {} });
    await assert.rejects(openBrief(silent, 't', 'example-org/example-app', { title: 'T', body: 'B' }), /did not say which/);
    const bare = new FakeSys().route('POST', `${REPO}/issues`, { status: 500, json: null });
    await assert.rejects(openBrief(bare, 't', 'example-org/example-app', { title: 'T', body: 'B' }), /\(HTTP 500\)$/);
  });

  it("adds the issue to the organisation's open Project by title, past a full page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 100, title: `P${i}` }));
    const sys = new FakeSys()
      .route('GET', REPO, { status: 200, json: { owner: { login: 'example-org', type: 'Organization' } } })
      .route('GET', '/orgs/example-org/projectsV2?per_page=100&page=1', { status: 200, json: full })
      .route('GET', '/orgs/example-org/projectsV2?per_page=100&page=2', { status: 200, json: [{ number: 3, title: 'Board', state: 'closed' }, { number: 4, title: 'Board' }] })
      .route('POST', '/orgs/example-org/projectsV2/4/items', { status: 201, json: {} });
    await addToProject(sys, 't', 'example-org/example-app', 900, 'Board');
    assert.deepEqual(sys.requests.at(-1)?.body, { type: 'Issue', id: 900 });
  });

  it("uses a user's Projects, and refuses a title it cannot find or a list it cannot read", async () => {
    const sys = new FakeSys()
      .route('GET', REPO, { status: 200, json: { owner: { login: 'someone', type: 'User' } } })
      .route('GET', '/users/someone/projectsV2?per_page=100&page=1', { status: 200, json: [{ number: 1, title: 'Board', closed_at: '2026-01-01' }] });
    await assert.rejects(addToProject(sys, 't', 'example-org/example-app', 900, 'Board'), /someone has no open Project titled "Board"/);
    const odd = new FakeSys().route('GET', REPO, { status: 200, json: null }).route('GET', '/orgs/example-org/projectsV2?per_page=100&page=1', { status: 200, json: {} });
    await assert.rejects(addToProject(odd, 't', 'example-org/example-app', 900, 'Board'), /did not list example-org's Projects/);
  });
});

describe('readBrief', () => {
  const open = { number: 9, state: 'open', state_reason: null, type: { name: 'Brief' }, body: 'B' };

  it('reads an open brief', async () => {
    const sys = new FakeSys().route('GET', `${REPO}/issues/9`, { status: 200, json: open });
    assert.deepEqual(await readBrief(sys, 't', 'example-org/example-app', 9), { number: 9, state: 'OPEN', stateReason: null, type: 'Brief', body: 'B', closingSha: null });
  });

  it('reads no brief from a missing issue, a pull request or another number', async () => {
    for (const [status, json] of [[404, null], [410, null], [200, { ...open, pull_request: {} }], [200, { ...open, number: 8 }], [500, null]] as const) {
      const sys = new FakeSys().route('GET', `${REPO}/issues/9`, { status, json });
      assert.equal(await readBrief(sys, 't', 'example-org/example-app', 9), null);
    }
  });

  const crossed = (number: number, merged: string | null, repo = 'https://api.github.com/repos/Example-Org/example-app') => ({
    event: 'cross-referenced',
    source: { issue: { number, repository_url: repo, pull_request: { merged_at: merged } } },
  });
  const closed = (timeline: unknown[]): FakeSys =>
    new FakeSys()
      .route('GET', `${REPO}/issues/9`, { status: 200, json: { ...open, state: 'closed', state_reason: 'completed', type: null, body: null } })
      .route('GET', `${REPO}/issues/9/timeline?per_page=100&page=1`, { status: 200, json: timeline })
      .route('GET', REPO, { status: 200, json: { default_branch: 'main' } });

  it('finds the newest merged pull request into the default branch saying Fixes, past others', async () => {
    const sys = closed([
      crossed(1, '2026-01-01'),
      { event: 'closed', commit_id: null },
      { event: 'reopened', source: null },
      crossed(2, '2026-01-02'),
      crossed(3, '2026-01-03'),
      crossed(4, '2026-01-04', 'https://api.github.com/repos/other/repo'),
      crossed(5, null),
      { event: 'cross-referenced', source: { issue: { number: 6, repository_url: 'x' } } },
      { event: 'cross-referenced' },
    ])
      .route('GET', `${REPO}/pulls/3`, { status: 200, json: { title: 'x', body: 'Fixes #9', merged_at: '2026-01-03', merge_commit_sha: 'e'.repeat(40), base: { ref: 'release' } } })
      .route('GET', `${REPO}/pulls/2`, { status: 200, json: { title: 'x', body: 'see #9', merged_at: '2026-01-02', merge_commit_sha: 'd'.repeat(40), base: { ref: 'main' } } })
      .route('GET', `${REPO}/pulls/1`, { status: 200, json: { title: 'Fixes #9', body: null, merged_at: '2026-01-01', merge_commit_sha: SHA, base: { ref: 'main' } } });
    assert.deepEqual(await readBrief(sys, 't', 'example-org/example-app', 9), { number: 9, state: 'CLOSED', stateReason: 'completed', type: null, body: '', closingSha: SHA });
    assert.equal(sys.requests.some((one) => /pulls\/[456]$/.test(one.url)), false, 'only merged pull requests of this repository are read');
  });

  it('finds no fix when no merged pull request says Fixes, and reads no repository without one', async () => {
    const none = closed([{ event: 'closed', commit_id: null }]);
    assert.equal((await readBrief(none, 't', 'example-org/example-app', 9))?.closingSha, null);
    assert.equal(none.requests.some((one) => one.url === `https://api.github.com${REPO}`), false);
    const unsaid = closed([crossed(1, '2026-01-01')]).route('GET', `${REPO}/pulls/1`, { status: 200, json: { merged_at: '2026-01-01', merge_commit_sha: null, base: { ref: 'main' } } });
    assert.equal((await readBrief(unsaid, 't', 'example-org/example-app', 9))?.closingSha, null);
    const empty = closed([crossed(1, '2026-01-01')]).route('GET', `${REPO}/pulls/1`, { status: 200, json: null });
    assert.equal((await readBrief(empty, 't', 'example-org/example-app', 9))?.closingSha, null);
  });
});
