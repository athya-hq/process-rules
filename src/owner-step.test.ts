import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Call, FakeSys, capture } from './fake.test.ts';
import { ISSUE_TYPES } from './issue-types.ts';
import { FOLDER_PREFIX, REVOKE, folderRoot, leftBehind, ownerStep, ownerStepArgs, stepScopes } from './owner-step.ts';
import { run } from './run.ts';
import type { ExecResult } from './types.ts';

const OWNER = 'example-owner';
const SECRET = 'gho_throwaway_secret';
const ROOT = '/var/folders/xy/T';
const DIR = `${ROOT}/${FOLDER_PREFIX}1`;

type Reply = { status: number; json?: unknown } | ((body: unknown) => { status: number; json?: unknown });

/** A Mac where the owner signs in to gh in the browser, and GitHub answers `gh api` from `replies`. */
function world(replies: Record<string, Reply> = {}, scopes = 'admin:org, gist, read:org, repo'): { sys: FakeSys; api: Call[] } {
  const sys = new FakeSys();
  sys.ghToken = SECRET;
  const api: Call[] = [];
  const routes: Record<string, Reply> = { 'GET user': { status: 200, json: { login: OWNER } }, ...replies };
  sys.execOverride = (call): ExecResult | undefined => {
    if (call.command === 'getconf') return { code: 0, stdout: `${ROOT}/\n`, stderr: '' };
    if (call.command !== 'gh' || call.args[0] !== 'api') return undefined;
    api.push(call);
    const at = call.args.indexOf('--method');
    const method = at === -1 ? 'GET' : (call.args[at + 1] as string);
    const route = routes[`${method} ${call.args[1]}`] ?? { status: 404, json: { message: 'Not Found' } };
    const { status, json } = typeof route === 'function' ? route(call.input === undefined ? undefined : JSON.parse(call.input)) : route;
    const body = json === undefined ? '' : JSON.stringify(json);
    const head = call.args.includes('--include') ? `HTTP/2.0 ${status} OK\r\nX-Oauth-Scopes: ${scopes}\r\nContent-Type: application/json\r\n\r\n` : '';
    return status < 400 ? { code: 0, stdout: `${head}${body}`, stderr: '' } : { code: 1, stdout: `${head}${body}`, stderr: `gh: ${(json as { message?: string })?.message ?? 'failed'} (HTTP ${status})\n` };
  };
  sys.answers = ['yes'];
  return { sys, api };
}

const ADMIN = { status: 200, json: { role: 'admin', state: 'active' } };
const types = (enabled: Record<string, boolean>): { status: number; json: unknown } => ({
  status: 200,
  json: ISSUE_TYPES.filter((type) => type.name in enabled).map((type, at) => ({ id: at + 1, ...type, is_enabled: enabled[type.name] })),
});

/** What a run must never do with the token: put it in a command's arguments, its output, or a file outside the throwaway folder. */
function noLeak(sys: FakeSys, out: string[], err: string[]): void {
  for (const call of sys.calls) assert.ok(!JSON.stringify({ args: call.args, env: call.env, input: call.input }).includes(SECRET), `token in a command's arguments, environment or input: ${call.command}`);
  for (const line of [...out, ...err]) assert.ok(!line.includes(SECRET), `token printed: ${line}`);
  for (const [path, data] of sys.files) if (data.includes(SECRET)) assert.ok(path.startsWith(`${DIR}/`), `token written to ${path}`);
}

/**
 * The throwaway folder deleted, never `gh auth logout` (it deletes gh's keychain entries whatever
 * GH_CONFIG_DIR says), and the revoke link the last line.
 */
function cleaned(sys: FakeSys, out: string[]): void {
  assert.ok(sys.removed.includes(DIR));
  assert.ok(![...sys.files.keys()].some((path) => path.startsWith(`${DIR}/`)));
  assert.ok(!sys.calls.some((call) => call.command === 'gh' && call.args[0] === 'auth' && call.args[1] !== 'login'));
  assert.equal(out.at(-1), `The GitHub CLI token stays valid on GitHub until you revoke it: ${REVOKE}`);
  assert.equal(sys.interrupts.length, 0);
}

describe('owner-step arguments', () => {
  it('reads each step', () => {
    assert.deepEqual(ownerStepArgs(['issue-types', 'veda-hq']), { step: 'issue-types', org: 'veda-hq' });
    assert.deepEqual(ownerStepArgs(['label', 'veda-hq/niyam', '#240', 'add', 'approved']), { step: 'label', repo: 'veda-hq/niyam', number: 240, action: 'add', label: 'approved' });
    assert.deepEqual(ownerStepArgs(['required-checks', 'veda-hq/niyam', 'main']), { step: 'required-checks', repo: 'veda-hq/niyam', ruleset: 'main' });
    assert.deepEqual(stepScopes({ step: 'issue-types', org: 'x' }), ['admin:org']);
    assert.deepEqual(stepScopes({ step: 'required-checks', repo: 'a/b', ruleset: 'main' }), ['repo']);
  });

  it('refuses anything else as bad usage, before any sign-in', async () => {
    const bad: [string[], RegExp][] = [
      [[], /takes one of: issue-types <org>/],
      [['tea'], /no step "tea"/],
      [['issue-types'], /takes one argument/],
      [['issue-types', 'not/an-org'], /organisation's login/],
      [['label', 'veda-hq/niyam', '7', 'add'], /takes 4 arguments/],
      [['label', 'niyam', '7', 'add', 'approved'], /owner\/name, not "niyam"/],
      [['label', 'veda-hq/niyam', 'x7', 'add', 'approved'], /number, not "x7"/],
      [['label', 'veda-hq/niyam', '7', 'toggle', 'approved'], /add or remove/],
      [['label', 'veda-hq/niyam', '7', 'add', 'bug'], /approved and do-not-merge alone/],
      [['required-checks', 'veda-hq/niyam', ' '], /ruleset id or name/],
    ];
    for (const [args, why] of bad) {
      const { sys } = world();
      const { io, err } = capture();
      assert.equal(await run(['owner-step', ...args], io, () => sys), 2, args.join(' '));
      assert.match(err.join('\n'), why);
      assert.equal(sys.temps.length, 0);
    }
  });
});

describe('owner-step', () => {
  it('refuses in an agent session, and without a terminal, before any folder or sign-in', async () => {
    for (const env of [{ NIYAM_AGENT: 'ExampleBot' }, { CLAUDECODE: '1' }]) {
      const { sys } = world();
      sys.env = env;
      const { io, err } = capture();
      assert.equal(await run(['owner-step', 'issue-types', 'veda-hq'], io, () => sys), 1);
      assert.match(err.join('\n'), /your own terminal, not in an agent session/);
      assert.equal(sys.temps.length, 0);
      assert.equal(sys.calls.length, 0);
    }
    const { sys } = world();
    sys.tty = false;
    const { io, err } = capture();
    assert.equal(await ownerStep(sys, io, ['issue-types', 'veda-hq']), 1);
    assert.match(err.join('\n'), /no terminal to ask in/);
    assert.equal(sys.temps.length, 0);
  });

  it('adds the issue types an organisation lacks, enables the disabled ones, in a throwaway gh signed out after', async () => {
    let listed = types({ 'Work item': true, State: false, Decision: true, Brief: true });
    const { sys, api } = world({
      'GET user/memberships/orgs/veda-hq': ADMIN,
      'GET orgs/veda-hq/issue-types': () => listed,
      'POST orgs/veda-hq/issue-types': (body) => {
        listed = { status: 200, json: [...(listed.json as object[]), { id: 9, ...(body as object) }] };
        return { status: 201, json: body };
      },
      'PUT orgs/veda-hq/issue-types/2': (body) => {
        listed = { status: 200, json: (listed.json as { id: number }[]).map((type) => (type.id === 2 ? { ...type, ...(body as object) } : type)) };
        return { status: 200, json: body };
      },
    });
    sys.env = { GH_TOKEN: 'ghp_agent', TMPDIR: '/elsewhere', PATH: '/usr/bin' };
    const { io, out, err } = capture();
    assert.equal(await run(['owner-step', 'issue-types', 'veda-hq'], io, () => sys), 0);
    const login = sys.calls.find((call) => call.args[1] === 'login');
    assert.deepEqual(login?.args, ['auth', 'login', '-h', 'github.com', '-p', 'https', '--skip-ssh-key', '-w', '-s', 'admin:org', '--insecure-storage']);
    for (const call of sys.calls.filter((one) => one.command === 'gh')) {
      assert.equal(call.env?.GH_CONFIG_DIR, DIR);
      assert.equal(call.env?.GH_PAGER, 'cat');
      assert.equal(call.env?.GH_TOKEN, undefined);
      assert.equal(call.env?.GIT_CONFIG_GLOBAL, `${DIR}/gitconfig`);
    }
    const text = out.join('\n');
    assert.match(text, /one-time code 1881-F156 \(copied\)/);
    assert.match(text, /signed in as example-owner/);
    assert.match(text, /owner-step will make these 2 changes:\n {4}add the issue type Slice \(green\) to veda-hq: .*\n {4}enable the issue type State in veda-hq, now disabled/);
    assert.deepEqual(sys.chosen, ['Make these changes?']);
    assert.ok(text.indexOf('owner-step will') < text.indexOf('✓ veda-hq has the issue type Slice'));
    assert.match(text, /✓ veda-hq has the issue type State, enabled/);
    assert.match(text, /✓ deleted the throwaway gh folder and the token in it/);
    assert.deepEqual(
      api.filter((call) => call.args.includes('--method')).map((call) => `${call.args[call.args.indexOf('--method') + 1]} ${call.args[1]}`),
      ['POST orgs/veda-hq/issue-types', 'PUT orgs/veda-hq/issue-types/2'],
    );
    cleaned(sys, out);
    noLeak(sys, out, err);
  });

  it('changes nothing when the organisation has every type, nor before the yes, nor after a no', async () => {
    const all = Object.fromEntries(ISSUE_TYPES.map((type) => [type.name, true]));
    const { sys, api } = world({ 'GET user/memberships/orgs/veda-hq': ADMIN, 'GET orgs/veda-hq/issue-types': types(all) });
    const { io, out } = capture();
    assert.equal(await ownerStep(sys, io, ['issue-types', 'veda-hq']), 0);
    assert.match(out.join('\n'), /✓ nothing to change: veda-hq has every work model issue type, enabled/);
    assert.deepEqual(sys.chosen, []);
    assert.ok(!api.some((call) => call.args.includes('--method')));
    cleaned(sys, out);

    const no = world({ 'GET user/memberships/orgs/veda-hq': ADMIN, 'GET orgs/veda-hq/issue-types': types({}) });
    no.sys.answers = ['no'];
    const said = capture();
    assert.equal(await ownerStep(no.sys, said.io, ['issue-types', 'veda-hq']), 0);
    assert.match(said.out.join('\n'), /make these 5 changes[\s\S]*✓ nothing changed: you said no/);
    assert.ok(!no.api.some((call) => call.args.includes('--method')));
    cleaned(no.sys, said.out);
  });

  it('refuses a login that is not an owner, changing nothing', async () => {
    const { sys, api } = world({ 'GET user/memberships/orgs/veda-hq': { status: 200, json: { role: 'member', state: 'active' } }, 'GET orgs/veda-hq/issue-types': types({}) });
    const { io, out } = capture();
    assert.equal(await ownerStep(sys, io, ['issue-types', 'veda-hq']), 1);
    assert.match(out.join('\n'), /✗ example-owner is not an owner of the organisation veda-hq; sign in to github.com in the browser as the owner/);
    assert.ok(!api.some((call) => call.args[1] === 'orgs/veda-hq/issue-types'));
    cleaned(sys, out);
  });

  it('fails a sign-in that did not finish, left no token in the folder, or lacks the scope', async () => {
    const declined = world();
    declined.sys.ghToken = undefined;
    const first = capture();
    assert.equal(await ownerStep(declined.sys, first.io, ['issue-types', 'veda-hq']), 1);
    assert.match(first.out.join('\n'), /✗ the GitHub sign-in in the browser did not finish, so nothing changed[\s\S]*✓ deleted the throwaway gh folder/);
    assert.equal(declined.api.length, 0);
    cleaned(declined.sys, first.out);

    // gh said it finished, but its token is not in the folder: gh would read the keychain's, so nothing is asked.
    const elsewhere = world();
    const login = elsewhere.sys.execOverride;
    elsewhere.sys.execOverride = (call) => (call.args[1] === 'login' ? { code: 0, stdout: '', stderr: '' } : login(call));
    const second = capture();
    assert.equal(await ownerStep(elsewhere.sys, second.io, ['issue-types', 'veda-hq']), 1);
    assert.match(second.out.join('\n'), /✗ the GitHub sign-in in the browser did not finish/);
    assert.equal(elsewhere.api.length, 0);

    const narrow = world({}, 'gist, read:org, repo');
    const third = capture();
    assert.equal(await ownerStep(narrow.sys, third.io, ['issue-types', 'veda-hq']), 1);
    assert.match(third.out.join('\n'), /✗ the sign-in did not grant admin:org, so nothing changed/);
    cleaned(narrow.sys, third.out);

    const refused = world({ 'GET user': { status: 401, json: { message: 'Bad credentials' } } });
    const fourth = capture();
    assert.equal(await ownerStep(refused.sys, fourth.io, ['issue-types', 'veda-hq']), 1);
    assert.match(fourth.out.join('\n'), /✗ GitHub did not accept the sign-in \(gh: Bad credentials \(HTTP 401\)\)/);
  });

  it('cleans up at a Ctrl-C during the sign-in, and stops before the next change at one during a change', async () => {
    const during = world();
    const login = during.sys.execOverride;
    during.sys.execOverride = (call) => {
      if (call.args[1] !== 'login') return login(call);
      during.sys.files.set(`${DIR}/hosts.yml`, `github.com:\n    oauth_token: ${SECRET}\n`);
      during.sys.interrupt();
      return { code: 130, stdout: '', stderr: '' };
    };
    const first = capture();
    assert.equal(await ownerStep(during.sys, first.io, ['issue-types', 'veda-hq']), 130);
    assert.match(first.out.join('\n'), /✗ stopped by Ctrl-C; nothing changed\n✓ deleted the throwaway gh folder and the token in it/);
    cleaned(during.sys, first.out);
    assert.equal(during.sys.removed.filter((path) => path === DIR).length, 1);

    const { sys, api } = world({
      'GET user/memberships/orgs/veda-hq': ADMIN,
      'GET orgs/veda-hq/issue-types': types({}),
      'POST orgs/veda-hq/issue-types': () => {
        sys.interrupt();
        return { status: 201, json: {} };
      },
    });
    const second = capture();
    assert.equal(await ownerStep(sys, second.io, ['issue-types', 'veda-hq']), 130);
    const text = second.out.join('\n');
    assert.match(text, /✗ add the issue type Work item .*: stopped by Ctrl-C; check it on GitHub/);
    assert.match(text, /✗ add the issue type Slice .*: not done, stopped by Ctrl-C/);
    assert.equal(api.filter((call) => call.args.includes('POST')).length, 1);
    cleaned(sys, second.out);

    // As in a terminal: the Ctrl-C kills the gh call, and its handler runs once the event loop does.
    const killed = world({
      'GET user/memberships/orgs/veda-hq': ADMIN,
      'GET orgs/veda-hq/issue-types': types({}),
      'POST orgs/veda-hq/issue-types': () => {
        pending = true;
        return { status: 500, json: { message: 'signal: interrupt' } };
      },
    });
    let pending = false;
    killed.sys.sleep = () => {
      if (pending) killed.sys.interrupt();
      pending = false;
      return Promise.resolve();
    };
    const late = capture();
    assert.equal(await ownerStep(killed.sys, late.io, ['issue-types', 'veda-hq']), 130);
    assert.match(late.out.join('\n'), /✗ add the issue type Work item .*: stopped by Ctrl-C; check it on GitHub\n✗ add the issue type Slice .*: not done, stopped by Ctrl-C/);
    assert.equal(killed.api.filter((call) => call.args.includes('POST')).length, 1);
    cleaned(killed.sys, late.out);

    const atYes = world({ 'GET user/memberships/orgs/veda-hq': ADMIN, 'GET orgs/veda-hq/issue-types': types({}) });
    atYes.sys.choose = () => {
      atYes.sys.interrupt();
      return Promise.resolve(true);
    };
    const third = capture();
    assert.equal(await ownerStep(atYes.sys, third.io, ['issue-types', 'veda-hq']), 130);
    assert.ok(!atYes.api.some((call) => call.args.includes('--method')));
  });

  it('marks a change GitHub did not make ✗, and says when the folder could not be deleted', async () => {
    const { sys } = world({
      'GET user/memberships/orgs/veda-hq': ADMIN,
      'GET orgs/veda-hq/issue-types': types({}),
      'POST orgs/veda-hq/issue-types': { status: 422, json: { message: 'Validation Failed' } },
    });
    const { io, out } = capture();
    assert.equal(await ownerStep(sys, io, ['issue-types', 'veda-hq']), 1);
    assert.match(out.join('\n'), /✗ add the issue type Work item .*: adding Work item: gh: Validation Failed \(HTTP 422\)/);

    const stuck = world({ 'GET user/memberships/orgs/veda-hq': ADMIN, 'GET orgs/veda-hq/issue-types': types(Object.fromEntries(ISSUE_TYPES.map((type) => [type.name, true]))) });
    const exists = stuck.sys.exists.bind(stuck.sys);
    stuck.sys.exists = (path) => path === DIR || exists(path);
    const second = capture();
    assert.equal(await ownerStep(stuck.sys, second.io, ['issue-types', 'veda-hq']), 1);
    assert.match(second.out.join('\n'), new RegExp(`✗ could not delete the throwaway gh folder ${DIR}, which holds the token → rm -rf ${DIR}`));

    const throws = world({ 'GET user/memberships/orgs/veda-hq': ADMIN, 'GET orgs/veda-hq/issue-types': types(Object.fromEntries(ISSUE_TYPES.map((type) => [type.name, true]))) });
    throws.sys.remove = () => {
      throw new Error('EPERM');
    };
    const third = capture();
    assert.equal(await ownerStep(throws.sys, third.io, ['issue-types', 'veda-hq']), 1);
    assert.match(third.out.join('\n'), /✗ could not delete the throwaway gh folder/);
  });

  it('adds a label to an organisation repository’s issue, as one of its owners', async () => {
    let labels = [{ name: 'bug' }];
    const { sys, api } = world({
      'GET repos/veda-hq/niyam': { status: 200, json: { owner: { login: 'veda-hq', type: 'Organization' } } },
      'GET user/memberships/orgs/veda-hq': ADMIN,
      'GET repos/veda-hq/niyam/labels/approved': { status: 200, json: { name: 'approved' } },
      'GET repos/veda-hq/niyam/issues/240': () => ({ status: 200, json: { title: 'P-51 owner-step', labels } }),
      'POST repos/veda-hq/niyam/issues/240/labels': (body) => {
        labels = [...labels, ...(body as { labels: string[] }).labels.map((name) => ({ name }))];
        return { status: 200, json: labels };
      },
    }, 'gist, read:org, repo');
    const { io, out, err } = capture();
    assert.equal(await ownerStep(sys, io, ['label', 'veda-hq/niyam', '240', 'add', 'approved']), 0);
    assert.deepEqual(sys.calls.find((call) => call.args[1] === 'login')?.args.slice(-3), ['-s', 'repo', '--insecure-storage']);
    const text = out.join('\n');
    assert.match(text, /owner-step will make this change:\n {4}add the label approved to veda-hq\/niyam#240 "P-51 owner-step"/);
    assert.deepEqual(sys.chosen, ['Make this change?']);
    assert.match(text, /✓ veda-hq\/niyam#240 has the label approved/);
    assert.equal(api.find((call) => call.args.includes('POST'))?.input, JSON.stringify({ labels: ['approved'] }));
    cleaned(sys, out);
    noLeak(sys, out, err);
  });

  it('takes a label off a user’s repository as that user, and checks it is gone', async () => {
    let labels = [{ name: 'do-not-merge' }];
    const replies = (owner: string): Record<string, Reply> => ({
      'GET repos/example-owner/app': { status: 200, json: { owner: { login: owner, type: 'User' } } },
      'GET repos/example-owner/app/labels/do-not-merge': { status: 200, json: {} },
      'GET repos/example-owner/app/issues/3': () => ({ status: 200, json: { labels } }),
      'DELETE repos/example-owner/app/issues/3/labels/do-not-merge': () => {
        labels = [];
        return { status: 200, json: [] };
      },
    });
    const { sys } = world(replies('Example-Owner'), 'repo');
    const { io, out } = capture();
    assert.equal(await ownerStep(sys, io, ['label', 'example-owner/app', '3', 'remove', 'do-not-merge']), 0);
    assert.match(out.join('\n'), /take the label do-not-merge off example-owner\/app#3\n[\s\S]*✓ example-owner\/app#3 no longer has the label do-not-merge/);

    // Gone already: nothing to change.
    const again = world(replies('example-owner'), 'repo');
    const second = capture();
    assert.equal(await ownerStep(again.sys, second.io, ['label', 'example-owner/app', '3', 'remove', 'do-not-merge']), 0);
    assert.match(second.out.join('\n'), /✓ nothing to change: example-owner\/app#3 does not have the label do-not-merge/);

    labels = [{ name: 'do-not-merge' }];
    const other = world(replies('someone-else'), 'repo');
    const third = capture();
    assert.equal(await ownerStep(other.sys, third.io, ['label', 'example-owner/app', '3', 'remove', 'do-not-merge']), 1);
    assert.match(third.out.join('\n'), /✗ example-owner\/app is someone-else's, not example-owner's/);
  });

  it('refuses a label the repository lacks, and says when the label does not stick', async () => {
    const repo = { 'GET repos/veda-hq/niyam': { status: 200, json: { owner: { login: 'veda-hq', type: 'Organization' } } }, 'GET user/memberships/orgs/veda-hq': ADMIN };
    const { sys } = world(repo, 'repo');
    const { io, out } = capture();
    assert.equal(await ownerStep(sys, io, ['label', 'veda-hq/niyam', '9', 'add', 'approved']), 1);
    assert.match(out.join('\n'), /✗ veda-hq\/niyam has no label approved, and owner-step makes none; niyam onboard does/);

    const flaky = world({ ...repo, 'GET repos/veda-hq/niyam/labels/approved': { status: 502, json: { message: 'Bad Gateway' } } }, 'repo');
    const second = capture();
    assert.equal(await ownerStep(flaky.sys, second.io, ['label', 'veda-hq/niyam', '9', 'add', 'approved']), 1);
    assert.match(second.out.join('\n'), /✗ reading veda-hq\/niyam's label approved: gh: Bad Gateway \(HTTP 502\)/);

    const ignored = world({
      ...repo,
      'GET repos/veda-hq/niyam/labels/approved': { status: 200, json: {} },
      'GET repos/veda-hq/niyam/issues/9': { status: 200, json: { title: 7, labels: [{}] } },
      'POST repos/veda-hq/niyam/issues/9/labels': { status: 200, json: [] },
    }, 'repo');
    const third = capture();
    assert.equal(await ownerStep(ignored.sys, third.io, ['label', 'veda-hq/niyam', '9', 'add', 'approved']), 1);
    assert.match(third.out.join('\n'), /✗ add the label approved to veda-hq\/niyam#9: GitHub shows veda-hq\/niyam#9 without approved afterwards/);

    const nobody = world({ 'GET repos/veda-hq/niyam': { status: 200, json: {} } }, 'repo');
    const fourth = capture();
    assert.equal(await ownerStep(nobody.sys, fourth.io, ['label', 'veda-hq/niyam', '9', 'add', 'approved']), 1);
    assert.match(fourth.out.join('\n'), /✗ GitHub did not say who owns veda-hq\/niyam/);
  });
});

const encoded = (text: string): { status: number; json: unknown } => ({ status: 200, json: { content: Buffer.from(text).toString('base64') } });
/** A client's workflow as onboard writes it, in .github/workflows/niyam.yml: its niyam job, named niyam, calling the shared checks. */
const WORKFLOW = [
  'jobs:',
  '  niyam:',
  '    name: niyam',
  "    if: github.event_name == 'pull_request'",
  '    # the shared checks',
  '    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.6.6',
  '    with:',
  '      niyam-ref: v0.6.6',
  '',
  '  niyam-weekly:',
  '    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.6.6',
  '',
].join('\n');
/** The same as onboard wrote it before P-56, under the old ids, which no release reads since P-57. */
const OLD_WORKFLOW = WORKFLOW.replace('  niyam:', '  process-rules:').replace('  niyam-weekly:', '  process-rules-weekly:').replace('niyam-ref:', 'process-rules-ref:');
/** The shared checks at that version, by their jobs' names. */
const SHARED = ['jobs:', '  settings:', '    name: Settings', '  identity:', '    name: PR identity', '  work-rules:', "    name: 'Work rules'", '  design:', '    name: Design frames', ''].join('\n');

describe('owner-step required-checks', () => {
  const settings = (features?: string[]): { status: number; json: unknown } => ({
    status: 200,
    json: { content: Buffer.from(JSON.stringify({ owner: OWNER, agent: 'ExampleBot', ...(features ? { features } : {}) })).toString('base64') },
  });
  const checks = (...contexts: string[]): unknown => ({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) } });
  const rulesWorld = (rules: unknown[], extra: Record<string, Reply> = {}, put?: (body: { rules: unknown[] }) => unknown[]): ReturnType<typeof world> & { now: () => unknown[] } => {
    let now = rules;
    const made = world({
      'GET repos/veda-hq/niyam': { status: 200, json: { owner: { login: 'veda-hq', type: 'Organization' } } },
      'GET user/memberships/orgs/veda-hq': ADMIN,
      'GET repos/veda-hq/niyam/rulesets?includes_parents=false&per_page=100': { status: 200, json: [{ id: 5, name: 'main' }, { id: 6, name: 'release tags' }] },
      'GET repos/veda-hq/niyam/rulesets/5': () => ({ status: 200, json: { id: 5, name: 'main', rules: now } }),
      'PUT repos/veda-hq/niyam/rulesets/5': (body) => {
        now = put ? put(body as { rules: unknown[] }) : (body as { rules: unknown[] }).rules;
        return { status: 200, json: {} };
      },
      'GET repos/veda-hq/niyam/contents/.github/niyam.json': settings(['pr-identity', 'work-rules']),
      'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': encoded(WORKFLOW),
      'GET repos/veda-hq/niyam/contents/.github/workflows/checks.yml?ref=v0.6.6': encoded(SHARED),
      ...extra,
    }, 'repo');
    return { ...made, now: () => now };
  };

  it("adds the checks the repository's features turn on, keeping every other check and rule, and shows the before and after", async () => {
    const made = rulesWorld([{ type: 'deletion' }, checks('Typecheck, test, build', 'niyam / PR identity')]);
    const { io, out, err } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'MAIN']), 0);
    const text = out.join('\n');
    assert.match(text, /\.github\/niyam\.json turns on the checks niyam \/ PR identity, niyam \/ Work rules/);
    assert.match(text, /before: Typecheck, test, build, niyam \/ PR identity\n {2}after: {2}Typecheck, test, build, niyam \/ PR identity, niyam \/ Work rules/);
    assert.match(text, /make the ruleset main of veda-hq\/niyam also require niyam \/ Work rules/);
    assert.match(text, /✓ the ruleset main requires Typecheck, test, build, niyam \/ PR identity, niyam \/ Work rules/);
    assert.deepEqual(made.now(), [{ type: 'deletion' }, checks('Typecheck, test, build', 'niyam / PR identity', 'niyam / Work rules')]);
    cleaned(made.sys, out);
    noLeak(made.sys, out, err);
  });

  it('adds the rule when the ruleset has none, and finds the ruleset by id', async () => {
    const made = rulesWorld([{ type: 'deletion' }], { 'GET repos/veda-hq/niyam/contents/.github/niyam.json': settings() });
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', '5']), 0);
    assert.match(out.join('\n'), /before: none\n {2}after: {2}niyam \/ PR identity, niyam \/ Work rules, niyam \/ Design frames/);
    assert.deepEqual((made.now()[1] as { parameters: { required_status_checks: unknown[] } }).parameters.required_status_checks.length, 3);
  });

  it('reads no settings file, workflow or job id before niyam (P-57)', async () => {
    const settingsBefore = rulesWorld([checks()], {
      'GET repos/veda-hq/niyam/contents/.github/niyam.json': { status: 404, json: { message: 'Not Found' } },
      'GET repos/veda-hq/niyam/contents/.github/process-rules.json': settings(),
    });
    const first = capture();
    assert.equal(await ownerStep(settingsBefore.sys, first.io, ['required-checks', 'veda-hq/niyam', 'main']), 1);
    assert.match(first.out.join('\n'), /✗ veda-hq\/niyam has no \.github\/niyam\.json on its default branch/);
    /** Whether a run asked GitHub for a path before niyam. */
    const askedLegacy = (made: ReturnType<typeof rulesWorld>): boolean => made.api.some((call) => call.args.some((arg) => /process-rules\.(?:json|yml)/.test(arg)));
    assert.equal(askedLegacy(settingsBefore), false, 'the settings file before niyam is not even asked for');
    for (const extra of [
      { 'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': { status: 404, json: { message: 'Not Found' } }, 'GET repos/veda-hq/niyam/contents/.github/workflows/process-rules.yml': encoded(OLD_WORKFLOW) },
      { 'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': encoded(OLD_WORKFLOW) },
    ] as Record<string, Reply>[]) {
      const made = rulesWorld([checks()], extra);
      const said = capture();
      assert.equal(await ownerStep(made.sys, said.io, ['required-checks', 'veda-hq/niyam', 'main']), 1);
      assert.match(said.out.join('\n'), /✗ not adding niyam \/ PR identity: (?:veda-hq\/niyam has no \.github\/workflows\/niyam\.yml on its default branch|\.github\/workflows\/niyam\.yml has no niyam job calling the shared checks)/);
      assert.ok(!made.api.some((call) => call.args.includes('PUT')));
      assert.equal(askedLegacy(made), false, 'the workflow before P-56 is not even asked for');
    }
  });

  it("skips, as ✗, a check the repository's workflow does not run, adding the others", async () => {
    const older = ['jobs:', '  identity:', '    name: PR identity', ''].join('\n');
    const made = rulesWorld([checks()], { 'GET repos/veda-hq/niyam/contents/.github/workflows/checks.yml?ref=v0.6.6': encoded(older) });
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 1);
    const text = out.join('\n');
    assert.match(text, /make the ruleset main of veda-hq\/niyam also require niyam \/ PR identity\n/);
    assert.match(text, /✗ not adding niyam \/ Work rules: the shared checks \.github\/workflows\/niyam\.yml calls run no Work rules job, so it would never report and would hold every pull request → niyam onboard there, then run this again/);
    assert.match(text, /✓ the ruleset main requires niyam \/ PR identity/);

    // Its own checks, called by path, as niyam's repository does; a check required already needs no job.
    const own = rulesWorld([checks('niyam / Work rules')], {
      'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': encoded(WORKFLOW.replace('veda-hq/niyam/.github/workflows/checks.yml@v0.6.6', './.github/workflows/checks.yml')),
      'GET repos/veda-hq/niyam/contents/.github/workflows/checks.yml': encoded(SHARED),
    });
    const second = capture();
    assert.equal(await ownerStep(own.sys, second.io, ['required-checks', 'veda-hq/niyam', 'main']), 0);
    assert.match(second.out.join('\n'), /✓ the ruleset main requires niyam \/ Work rules, niyam \/ PR identity/);

    const cases: [Record<string, Reply>, RegExp][] = [
      [{ 'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': { status: 404, json: { message: 'Not Found' } } }, /veda-hq\/niyam has no \.github\/workflows\/niyam\.yml on its default branch/],
      [{ 'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': encoded('jobs:\n  build:\n    runs-on: x\n') }, /\.github\/workflows\/niyam\.yml has no niyam job calling the shared checks/],
      [{ 'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': encoded('jobs:\n  niyam:\n    runs-on: x\n') }, /\.github\/workflows\/niyam\.yml has no niyam job calling the shared checks/],
      [{ 'GET repos/veda-hq/niyam/contents/.github/workflows/checks.yml?ref=v0.6.6': { status: 404, json: { message: 'Not Found' } } }, /GitHub did not give the shared checks veda-hq\/niyam@v0\.6\.6 that .* calls \(gh: Not Found \(HTTP 404\)\)/],
    ];
    for (const [extra, why] of cases) {
      const one = rulesWorld([checks()], extra);
      const said = capture();
      assert.equal(await ownerStep(one.sys, said.io, ['required-checks', 'veda-hq/niyam', 'main']), 1, String(why));
      assert.match(said.out.join('\n'), new RegExp(`✗ not adding niyam / PR identity: (?:.*)${why.source}`));
      assert.deepEqual(one.sys.chosen, []);
      assert.ok(!one.api.some((call) => call.args.includes('PUT')));
    }
  });

  it('keeps an edit made to the ruleset while the owner read the plan', async () => {
    const made = rulesWorld([checks('niyam / PR identity')]);
    made.sys.choose = () => {
      // Someone adds a rule and a check before the yes.
      const edited = [{ type: 'deletion' }, checks('niyam / PR identity', 'Secret scans')];
      made.sys.execOverride = ((inner) => (call) => (call.args[1] === 'repos/veda-hq/niyam/rulesets/5' && !call.args.includes('PUT') && !putDone ? { code: 0, stdout: JSON.stringify({ id: 5, name: 'main', rules: edited }), stderr: '' } : inner(call)))(made.sys.execOverride);
      return Promise.resolve(true);
    };
    let putDone = false;
    const inner = made.sys.execOverride;
    made.sys.execOverride = (call) => {
      if (call.args.includes('PUT')) putDone = true;
      return inner(call);
    };
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 0);
    assert.deepEqual(made.now(), [{ type: 'deletion' }, checks('niyam / PR identity', 'Secret scans', 'niyam / Work rules')]);
    assert.match(out.join('\n'), /✓ the ruleset main requires niyam \/ PR identity, Secret scans, niyam \/ Work rules/);
  });

  it('writes nothing after a Ctrl-C that came during the read before the write', async () => {
    const made = rulesWorld([checks('niyam / PR identity')]);
    let reads = 0;
    const inner = made.sys.execOverride;
    made.sys.execOverride = (call) => {
      if (call.args[1] === 'repos/veda-hq/niyam/rulesets/5' && !call.args.includes('PUT')) reads++;
      return inner(call);
    };
    // The handler runs at the next pause: the one after the read before the write.
    made.sys.sleep = () => {
      if (reads === 2) made.sys.interrupt();
      return Promise.resolve();
    };
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 130);
    assert.match(out.join('\n'), /✗ make the ruleset main of veda-hq\/niyam also require niyam \/ Work rules: not done, stopped by Ctrl-C/);
    assert.ok(!made.api.some((call) => call.args.includes('PUT')));
    cleaned(made.sys, out);
  });

  it('changes nothing when every check is required already', async () => {
    const made = rulesWorld([checks('niyam / Work rules', 'niyam / PR identity')]);
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 0);
    assert.match(out.join('\n'), /✓ nothing to change: the ruleset main requires every check \.github\/niyam\.json turns on/);
    assert.ok(!made.api.some((call) => call.args.includes('PUT')));
  });

  it('refuses a ruleset it cannot find, settings it cannot read, and a result it cannot confirm', async () => {
    const cases: [ReturnType<typeof rulesWorld>, string, RegExp][] = [
      [rulesWorld([]), 'nightly', /✗ no ruleset of veda-hq\/niyam is "nightly"; its rulesets: main \(5\), release tags \(6\)/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/rulesets?includes_parents=false&per_page=100': { status: 200, json: [{ id: 5, name: 'main' }, { id: 7, name: 'Main' }] } }), 'main', /✗ more than one ruleset/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/rulesets?includes_parents=false&per_page=100': { status: 200, json: null } }), 'main', /its rulesets: none/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/rulesets/5': { status: 200, json: { name: 'main' } } }), 'main', /✗ GitHub did not give the ruleset main's rules/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/contents/.github/niyam.json': { status: 404, json: {} } }), 'main', /✗ veda-hq\/niyam has no \.github\/niyam\.json on its default branch/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/contents/.github/niyam.json': { status: 200, json: {} } }), 'main', /✗ GitHub did not give veda-hq\/niyam's \.github\/niyam\.json/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/contents/.github/niyam.json': { status: 502, json: { message: 'Bad Gateway' } } }), 'main', /✗ reading veda-hq\/niyam's \.github\/niyam\.json: gh: Bad Gateway/],
      [rulesWorld([], { 'GET repos/veda-hq/niyam/contents/.github/niyam.json': encoded('{') }), 'main', /✗ veda-hq\/niyam's \.github\/niyam\.json is not JSON/],
      [rulesWorld([checks()], {}, (body) => body.rules.map(() => checks())), 'main', /✗ make the ruleset .*: GitHub shows the ruleset without niyam \/ PR identity, niyam \/ Work rules afterwards/],
      [rulesWorld([{ type: 'deletion' }, checks()], {}, (body) => body.rules.slice(1)), 'main', /GitHub shows the ruleset's other rules changed afterwards; check it at https:\/\/github\.com\/veda-hq\/niyam\/rules\/5/],
    ];
    for (const [made, ruleset, why] of cases) {
      const { io, out } = capture();
      assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', ruleset]), 1, String(why));
      assert.match(out.join('\n'), why);
      cleaned(made.sys, out);
    }
  });

  it('requires each check before P-53 under its niyam name in its place, its app kept, and drops one no job runs, showing it in the plan (P-57)', async () => {
    const made = rulesWorld([{ type: 'deletion' }, checks('Typecheck, test, build', 'process-rules / Work rules', 'process-rules / Old job')]);
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 0, out.join('\n'));
    const text = out.join('\n');
    assert.match(text, /make the ruleset main of veda-hq\/niyam require niyam \/ Work rules in place of process-rules \/ Work rules, and drop process-rules \/ Old job, which no workflow reports since P-53, and also require niyam \/ PR identity/);
    assert.match(text, /before: Typecheck, test, build, process-rules \/ Work rules, process-rules \/ Old job\n {2}after: {2}Typecheck, test, build, niyam \/ Work rules, niyam \/ PR identity/);
    assert.deepEqual(made.now(), [{ type: 'deletion' }, checks('Typecheck, test, build', 'niyam / Work rules', 'niyam / PR identity')]);
    assert.ok(!made.api.some((call) => call.args.some((arg) => arg.includes('branches/'))), 'no onboard branch asked for');
  });

  it('drops a check before P-53 beside its niyam one, and with every check required otherwise, still writes', async () => {
    const made = rulesWorld([checks('niyam / PR identity', 'process-rules / PR identity', 'niyam / Work rules')]);
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 0, out.join('\n'));
    assert.match(out.join('\n'), /make the ruleset main of veda-hq\/niyam require niyam \/ PR identity in place of process-rules \/ PR identity/);
    assert.deepEqual(made.now(), [checks('niyam / PR identity', 'niyam / Work rules')]);
  });

  it('drops a check before P-53 when the workflow cannot be read, and refuses a result that still requires it', async () => {
    const unread = rulesWorld([checks('niyam / PR identity', 'niyam / Work rules', 'process-rules / Work rules')], {
      'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': { status: 404, json: { message: 'Not Found' } },
    });
    const first = capture();
    assert.equal(await ownerStep(unread.sys, first.io, ['required-checks', 'veda-hq/niyam', 'main']), 0, first.out.join('\n'));
    assert.deepEqual(unread.now(), [checks('niyam / PR identity', 'niyam / Work rules')]);
    const kept = rulesWorld([checks('process-rules / PR identity')], {}, (body) => [...body.rules.map(() => checks('process-rules / PR identity', 'niyam / PR identity', 'niyam / Work rules'))]);
    const second = capture();
    assert.equal(await ownerStep(kept.sys, second.io, ['required-checks', 'veda-hq/niyam', 'main']), 1);
    assert.match(second.out.join('\n'), /GitHub shows the ruleset still requiring process-rules \/ PR identity afterwards/);
  });


  it('reads a workflow committed with CRLF line endings as the same workflow', async () => {
    const made = rulesWorld([checks('niyam / PR identity')], { 'GET repos/veda-hq/niyam/contents/.github/workflows/niyam.yml': encoded(WORKFLOW.replaceAll('\n', '\r\n')) });
    const { io, out } = capture();
    assert.equal(await ownerStep(made.sys, io, ['required-checks', 'veda-hq/niyam', 'main']), 0, out.join('\n'));
    assert.deepEqual(made.now(), [checks('niyam / PR identity', 'niyam / Work rules')]);
  });
});

describe('owner-step folders', () => {
  it("are in macOS's temporary folder for the user, else TMPDIR, else /tmp", () => {
    const { sys } = world();
    assert.equal(folderRoot(sys), ROOT);
    sys.platform = 'linux';
    sys.env = { TMPDIR: '/var/tmp/' };
    assert.equal(folderRoot(sys), '/var/tmp');
    sys.env = {};
    assert.equal(folderRoot(sys), '/tmp');
    sys.env = { TMPDIR: '' };
    assert.equal(folderRoot(sys), '/tmp');
  });

  it('left behind are doctor ▲s, saying when one still holds a token and never what it is', () => {
    const { sys } = world();
    assert.deepEqual(leftBehind(sys), []);
    sys.files.set(`${ROOT}/${FOLDER_PREFIX}ab/hosts.yml`, `github.com:\n    oauth_token: ${SECRET}\n`);
    sys.files.set(`${ROOT}/${FOLDER_PREFIX}cd/gitconfig`, '');
    sys.files.set(`${ROOT}/process-rules-ef/hosts.yml`, 'oauth_token: x');
    const found = leftBehind(sys);
    assert.deepEqual(found, [
      { mark: '▲', text: `an owner-step folder left behind holds a GitHub token: ${ROOT}/${FOLDER_PREFIX}ab`, fix: `with no owner-step running, rm -rf ${ROOT}/${FOLDER_PREFIX}ab, then revoke the GitHub CLI token at ${REVOKE}` },
      { mark: '▲', text: `an owner-step folder left behind: ${ROOT}/${FOLDER_PREFIX}cd`, fix: `with no owner-step running, rm -rf ${ROOT}/${FOLDER_PREFIX}cd` },
    ]);
    assert.ok(!JSON.stringify(found).includes(SECRET));
  });
});
