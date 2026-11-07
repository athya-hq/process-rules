import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BUILT_IN, Board, COPY_URL, OWNER_TOKEN, URL, repoJson, settledViews } from './fake-board.test.ts';
import { FIELDS, ISSUE_TYPES, LABELS } from './board.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, PULL_URL, RELEASE_SHA256, ROOT, TOKEN, capture } from './fake.test.ts';
import { cloudRepoScript } from './cloud.ts';
import { CLOUD_SETUP_PATH } from './onboard-pull.ts';
import type { HttpResult } from './types.ts';
import { pathsFor, sessionScript } from './agent.ts';
import { FEATURES } from './features.ts';
import { packageVersion } from './version.ts';
import { GUARD_COMMAND, HOOK_COMMAND, HOOKS_PATH, OLDER_HOOK_COMMANDS, OLDER_PRE_PUSH_HOOKS, PRE_PUSH_HOOK, REVIEW_THREAD_RULE, SETUP_FIRST, WORKFLOW_PATH, claudeSettings, jobsWithoutLibrary, olderWorkflows, onboard, onboardArgs, workflow, workflowPins, workflowUpdate } from './onboard.ts';
import { BASE_ENV } from './agent.ts';
import { actionsKey, sealedValue } from './fake-secrets.test.ts';

const SETTINGS = `${ROOT}/.github/process-rules.json`;
const HOOKS = `${ROOT}/${HOOKS_PATH}`;
const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
const PRE_PUSH = `${ROOT}/.git/hooks/pre-push`;
const REPO = '/repos/example-org/example-app';
const COLLABORATOR = `${REPO}/collaborators/ExampleBot`;
const PUSH = { status: 200, json: repoJson() };
const SESSION_ENTRY = { hooks: [{ type: 'command', command: HOOK_COMMAND }] };
const GUARD_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_COMMAND }] };
/** The Claude Code settings this release writes into an empty project. */
const CLAUDE = { hooks: { SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV, permissions: { allow: [REVIEW_THREAD_RULE] } };
const VERIFIED = {
  status: 200,
  json: { committer: { login: AGENT }, commit: { verification: { verified: true, reason: 'valid' } } },
};

/** A Mac set up for the agent, a client repo with nothing in it yet, the agent able to push, yes to everything. */
function fresh(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.delete(SETTINGS);
  sys.route('GET', '/users/example-owner', { status: 200, json: { id: 1, login: 'example-owner' } });
  sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'Organization' } });
  sys.route('GET', REPO, PUSH);
  sys.route('GET', `${REPO}/commits/abc123`, VERIFIED);
  new Board(sys);
  // Settings, hook, workflow, pre-push hook; issue types, labels, Project; test commit; and spares.
  sys.answers = Array<string>(12).fill('y');
  return sys;
}

/** The checkout's files, git's own folder aside. */
function checkout(sys: FakeSys): Map<string, string> {
  return new Map([...sys.files].filter(([path]) => path.startsWith(`${ROOT}/`) && !path.startsWith(`${ROOT}/.git/`)));
}

/** The repository's files as onboard's pull request leaves them: what it committed, else what the checkout has. */
function repo(sys: FakeSys): { get(path: string): string | undefined; has(path: string): boolean } {
  const get = (path: string): string | undefined => sys.committed.get(path.slice(ROOT.length + 1)) ?? sys.files.get(path);
  return { get, has: (path) => get(path) !== undefined };
}

/** As when the owner merges onboard's pull request: what it committed is now in the checkout. */
function merge(sys: FakeSys): void {
  for (const [path, text] of sys.committed) sys.files.set(`${ROOT}/${path}`, text);
  sys.committed.clear();
}

/** How many times onboard had the owner sign in in the browser. */
function signIns(sys: FakeSys): number {
  return sys.calls.filter((call) => call.command === 'gh' && call.args[1] === 'login').length;
}

/** Runs onboard, checking it leaves the checkout as it found it. */
async function run(sys: FakeSys, named: string[] = ['example-owner', AGENT]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  const before = checkout(sys);
  const code = await onboard(sys, io, named);
  assert.deepEqual(checkout(sys), before, "onboard changed the owner's checkout");
  return { code, out, err };
}

/** The plan's items under the group whose title starts with `title`: "label: detail", or the label alone. */
/** The repo's cloud setup file, as this release writes it. */
const CLOUD = `${ROOT}/${CLOUD_SETUP_PATH}`;
const CLOUD_FILE = cloudRepoScript(packageVersion(), RELEASE_SHA256);

function planned(out: string[], title: string): string[] {
  const start = out.findIndex((line) => line.startsWith(`◇  ${title}`));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of out.slice(start + 1)) {
    const item = /^│ {4}(\S.*)$/.exec(line)?.[1];
    if (item === undefined) break;
    const [label, detail] = item.split(/ {2,}/);
    items.push(detail ? `${label}: ${detail}` : (label as string));
  }
  return items;
}

/** What the run left to do by hand, as it printed it last. */
function byHand(out: string[]): string[] {
  const start = out.lastIndexOf('By hand:');
  return start === -1 ? [] : out.slice(start + 1).map((line) => line.trim());
}

/** The title and description of the pull request onboard opened, if it opened one. */
function opened(sys: FakeSys): { title: string; body: string } | undefined {
  const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
  return pull?.body as { title: string; body: string } | undefined;
}

/** Whether onboard changed anything outside the checkout: a write to GitHub, a push, a sign-in or a hook. */
function changedNothing(sys: FakeSys): boolean {
  const writes = sys.requests.filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.url.endsWith('/graphql') && /^\s*query/.test((r.body as { query?: string } | undefined)?.query ?? '')));
  return writes.length === 0 && !sys.calls.some((c) => c.command === 'git' && c.args[0] === 'push') && signIns(sys) === 0 && !sys.files.has(PRE_PUSH);
}

describe('onboard', () => {
  it("opens the files as the agent's pull request, finds the agent can push, and proves a Verified commit", async () => {
    const sys = fresh();
    const { code, out, err } = await run(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: 'ExampleBot', features: [...FEATURES] });
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), CLAUDE);
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
    assert.equal(sys.modes.get(PRE_PUSH), 0o755);
    assert.deepEqual(sys.dirs.filter((d) => d.startsWith(ROOT)), [], 'no folder made in the checkout');
    const v = packageVersion();
    assert.deepEqual(out, [
      `◆  process-rules onboard   v${v}`,
      '│  example-org/example-app · owner example-owner · agent ExampleBot',
      '│',
      '◇  Pull request',
      `│    process-rules.json  new, ${FEATURES.length} features on`,
      '│    settings.json       new',
      '│    workflow            new',
      `│    cloud-setup.sh      new, installs v${packageVersion()}`,
      '│    auto-merge          when checks pass',
      '│',
      '◇  GitHub — one sign-in as example-owner',
      '│    board        set up or check',
      '│    issue types  org-wide, if missing',
      '│',
      '◇  This Mac',
      '│    pre-push hook  new',
      '│',
      '◇  Claude cloud — by hand, once',
      '│    Setup script        process-rules cloud-setup, first',
      "│    claude.ai's GitHub  as ExampleBot",
      '│',
      '◇  Check',
      '│    one signed test commit by ExampleBot, deleted after',
      '│',
      '◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org',
      '│  one-time code 1881-F156 (copied)',
      '│  approve it at https://github.com/login/device',
      '◇  Signed in as example-owner',
      '◇  board',
      '◇  pre-push hook',
      '◇  test commit Verified as ExampleBot',
      '◇  pull request',
      `└  ${PULL_URL}  merges itself when checks pass`,
      '',
      'By hand:',
      `  review routine → https://github.com/athya-hq/process-rules/blob/v${v}/routines/review.md`,
      "  cloud sessions, once: claude.ai's GitHub as ExampleBot, Setup script from process-rules cloud-setup, first",
    ]);
    assert.deepEqual(sys.chosen, ['Go ahead?'], 'one question');
    assert.deepEqual(sys.opened, ['https://github.com/login/device'], 'the browser opens at the sign-in');
    assert.equal(sys.spinning, 0, 'every spinner stopped');
    assert.deepEqual(sys.spun, ['board', 'pre-push hook', 'test commit Verified as ExampleBot', 'pull request']);
    const git = sys.calls.filter((c) => c.command === 'git' && c.env);
    assert.deepEqual(git.map((c) => c.args.slice(0, 2).join(' ')), [
      'ls-remote https://github.com/example-org/example-app.git',
      'init -q',
      'fetch -q',
      'commit-tree -S',
      'push -q',
      'push -q',
      // The pull request's commit, in a temporary repository: never the checkout.
      'init -q',
      'fetch -q',
      'read-tree FETCH_HEAD',
      ...['settings', 'hooks', 'cloud setup', 'workflow'].flatMap(() => ['rev-parse --verify', 'hash-object -w', 'update-index --add']),
      'write-tree --missing-ok',
      'commit-tree -S',
      'push -q',
    ]);
    assert.ok(git.every((c) => c.env?.GH_TOKEN === TOKEN && c.env.GIT_COMMITTER_EMAIL === '42+ExampleBot@users.noreply.github.com'), 'every git step as the agent');
    assert.ok(git.slice(6).every((c) => c.cwd === '/tmp/process-rules-2'), 'the pull request is made in a temporary repository');
    assert.deepEqual(git.at(-1)?.args, ['push', '-q', 'https://github.com/example-org/example-app.git', '+abc123:refs/heads/process-rules/onboard']);
    assert.ok(sys.removed.includes('/tmp/process-rules-2'), 'the temporary repository is deleted');
    assert.deepEqual([...sys.committed.keys()], ['.github/process-rules.json', '.claude/settings.json', CLOUD_SETUP_PATH, '.github/workflows/process-rules.yml']);
    assert.equal(sys.committed.get(CLOUD_SETUP_PATH), cloudRepoScript(v, RELEASE_SHA256), 'the cloud setup file, at the pin, checked against the release');
    const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
    assert.equal(pull?.token, TOKEN, 'the agent opens the pull request');
    const { title, head, base, body } = pull?.body as { title: string; head: string; base: string; body: string };
    assert.deepEqual([title, head, base], [`chore(process-rules): onboard at v${v}`, 'process-rules/onboard', 'main']);
    assert.deepEqual(git.at(-2)?.args.slice(-2), ['-m', `chore(process-rules): onboard at v${v}`], 'the commit header is the title');
    assert.match(body, /^- `\.github\/process-rules\.json`: owner example-owner approves, agent ExampleBot builds, with identity, .* on$/m);
    assert.match(body, /^- `\.github\/workflows\/process-rules\.yml`: write \.github\/workflows\/process-rules\.yml, which runs the shared process-rules checks$/m);
    // The long explanations the terminal no longer prints.
    assert.ok(body.includes('\nDone at the terminal, outside this pull request:\n\n- board:\n  - issue types in example-org: Work item, Slice, State, Decision, Brief\n'), body);
    assert.ok(body.includes(`\n  - Project "example-app work": ${COPY_URL}\n  - fields: Step, Decision, Review date\n`), body);
    assert.ok(body.includes('\n- pre-push hook:\n  - wrote the pre-push git hook .git/hooks/pre-push, which checks an agent session pushes to GitHub as the agent, and the work rules\n'), body);
    assert.ok(body.includes('\n  - committer: ExampleBot; verified: true (valid)\n  - GitHub shows the test commit Verified by ExampleBot\n'), body);
    assert.ok(body.includes('\nLeft to do by hand:\n\n- The review routine: create a weekly Claude routine on example-org/example-app'), body);
    assert.ok(
      body.includes(
        `\n- Claude cloud sessions, once: connect claude.ai's GitHub as ExampleBot, and paste what process-rules cloud-setup prints into the cloud environment's Setup script, over any older process-rules part. It runs ${CLOUD_SETUP_PATH}, which onboard keeps at the pin, so a new release needs no new paste. ${SETUP_FIRST}\n`,
      ),
      body,
    );
    assert.ok(body.includes(`\n- \`${CLOUD_SETUP_PATH}\`: installs process-rules ${packageVersion()} in Claude cloud sessions, its download checked against its sha256\n`), body);
    assert.ok(!body.includes('Finish the Project'), 'a copy of the template leaves nothing to do by hand');
    assert.deepEqual(sys.calls.filter((c) => c.command === 'rm').at(-1)?.args, ['-rf', '/tmp/verify']);
    const reads = sys.requests.filter((r) => r.url === `https://api.github.com${REPO}`);
    assert.equal(reads[0]?.token, TOKEN, 'checks access as the agent');
  });

  it("uses GitHub's spelling of logins typed in another case", async () => {
    const sys = fresh();
    sys.route('GET', '/users/EXAMPLE-OWNER', { status: 200, json: { id: 1, login: 'example-owner' } });
    assert.equal((await run(sys, ['EXAMPLE-OWNER', 'examplebot'])).code, 0);
    assert.match(repo(sys).get(SETTINGS) ?? '', /"owner": "example-owner",\n {2}"agent": "ExampleBot"/);
  });

  it('reads the accounts from existing settings, and skips what is done', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.chosen, ['Go ahead?']);
    assert.deepEqual(planned(out, 'Pull request'), [], 'no file to change');
    assert.deepEqual(planned(out, 'This Mac'), [], 'the pre-push hook is there');
    assert.deepEqual(planned(out, 'Claude cloud — by hand, once'), [], 'the cloud setup file is there, so the Setup script was pasted');
    assert.deepEqual(planned(out, 'GitHub'), ['board: set up or check', 'issue types: org-wide, if missing']);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')), 'nothing to change, no pull request');
    assert.ok(!sys.calls.some((c) => c.args[0] === 'read-tree'));
    assert.ok(out.includes('└  Done; no file changes, so no pull request.'), out.join('\n'));
  });

  it('keeps the cloud setup file at the pin, asking for the Setup script paste only the first time', async () => {
    const settled = (sys: FakeSys): void => {
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
      sys.files.set(HOOKS, JSON.stringify(CLAUDE));
      sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    };
    const older = fresh();
    settled(older);
    older.files.set(CLOUD, cloudRepoScript('0.5.2', 'cd'.repeat(32)));
    const upgraded = await run(older, []);
    assert.equal(upgraded.code, 0);
    assert.deepEqual(planned(upgraded.out, 'Pull request'), [`cloud-setup.sh: v0.5.2 → v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.deepEqual(planned(upgraded.out, 'Claude cloud — by hand, once'), [], 'pasted before: the snippet runs the file');
    assert.deepEqual(byHand(upgraded.out), []);
    assert.equal(older.committed.get(CLOUD_SETUP_PATH), CLOUD_FILE);

    const edited = fresh();
    settled(edited);
    edited.files.set(CLOUD, `${CLOUD_FILE}echo ours\n`);
    assert.deepEqual(planned((await run(edited, [])).out, 'Pull request'), ['cloud-setup.sh: written again', 'auto-merge: when checks pass']);
    assert.equal(edited.committed.get(CLOUD_SETUP_PATH), CLOUD_FILE);

    const unreleased = fresh();
    settled(unreleased);
    unreleased.route('GET', `/repos/athya-hq/process-rules/releases/tags/v${packageVersion()}`, { status: 404, json: { message: 'Not Found' } });
    const left = await run(unreleased, []);
    assert.equal(left.code, 0);
    assert.ok(left.out.includes(`│  ! ${CLOUD_SETUP_PATH} left as it is: GitHub answered HTTP 404 for the v${packageVersion()} release`), left.out.join('\n'));
    assert.deepEqual(planned(left.out, 'Pull request'), []);
    assert.deepEqual(planned(left.out, 'Claude cloud — by hand, once'), [], 'no file for the snippet to run, so no paste');

    const undigested = fresh();
    settled(undigested);
    undigested.route('GET', `/repos/athya-hq/process-rules/releases/tags/v${packageVersion()}`, { status: 200, json: { assets: [{ name: `athya-hq-process-rules-${packageVersion()}.tgz`, digest: null }] } });
    assert.ok((await run(undigested, ['--dry-run'])).out.includes(`│  ! ${CLOUD_SETUP_PATH} left as it is: the v${packageVersion()} release names no sha256 for athya-hq-process-rules-${packageVersion()}.tgz`));

    const down = fresh();
    settled(down);
    const http = down.http.bind(down);
    down.http = (url, options) => (url.includes('/releases/tags/') ? Promise.reject(new Error('GET api.github.com/repos could not be made: ECONNRESET')) : http(url, options));
    assert.ok(
      (await run(down, ['--dry-run'])).out.includes(
        `│  ! ${CLOUD_SETUP_PATH} left as it is: GitHub could not be asked for the v${packageVersion()} release (GET api.github.com/repos could not be made: ECONNRESET)`,
      ),
    );
  });

  it('leaves CODEOWNERS as it is, naming the owner or not, and asks nothing about it', async () => {
    for (const [path, text] of [
      ['.github/CODEOWNERS', '# Owners\n* @example-owner\n/app/ @example-org/core @EXAMPLE-OWNER # app team\n'],
      ['CODEOWNERS', '* @example-org/core\n'],
    ] as const) {
      const sys = fresh();
      sys.files.set(`${ROOT}/${path}`, text);
      const { code, out, err } = await run(sys);
      assert.equal(code, 0, err.join('\n'));
      assert.ok(!sys.committed.has(path), 'the pull request leaves it out');
      assert.equal(repo(sys).get(`${ROOT}/${path}`), text);
      assert.ok(![...out, ...err, ...sys.asked, ...sys.chosen, opened(sys)?.body ?? ''].some((line) => line.includes('CODEOWNERS')), 'nothing says anything about it');
    }
  });

  describe('with settings listing two owners and two agents', () => {
    const TEAM = { owner: ['example-owner', 'Second-Owner'], agent: ['OtherBot', AGENT], features: [...FEATURES] };
    const team = (): FakeSys => {
      const sys = fresh();
      sys.files.set(SETTINGS, `${JSON.stringify(TEAM, null, 2)}\n`);
      sys.files.set(pathsFor(HOME, AGENT).session, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
      return sys;
    };

    it('works as the owner the browser signed in as and the agent set up on this Mac, leaving the lists as they are', async () => {
      const sys = team();
      const { code, out, err } = await run(sys, []);
      assert.equal(code, 0, [...out, ...err].join('\n'));
      assert.ok(out.includes('│  example-org/example-app · owner example-owner · agent ExampleBot'), out.join('\n'));
      assert.equal(repo(sys).get(SETTINGS), `${JSON.stringify(TEAM, null, 2)}\n`);
      // Only the sign-in tells which owner ran it, so it comes before the plan, and the pull request says why.
      assert.ok(out.indexOf('◇  Signed in as example-owner') < out.findIndex((line) => line.startsWith('◆')), out.join('\n'));
      assert.ok(out.includes('◇  GitHub — signed in as example-owner'), out.join('\n'));
      assert.match(opened(sys)?.body ?? '', /^- onboard signed in before showing its plan: \.github\/process-rules\.json names several owners, and only the sign-in tells which one ran it\.$/m);
    });

    it('works as the second owner when the browser signs in as them, with one sign-in', async () => {
      const sys = team();
      sys.acceptToken(OWNER_TOKEN, 'Second-Owner', { 'x-oauth-scopes': 'repo, read:org, project, admin:org, workflow' });
      sys.route('GET', '/users/Second-Owner', { status: 200, json: { id: 2, login: 'Second-Owner' } });
      const { code, out, err } = await run(sys, []);
      assert.equal(code, 0, [...out, ...err].join('\n'));
      assert.ok(out.includes('│  example-org/example-app · owner Second-Owner · agent ExampleBot'), out.join('\n'));
      assert.equal(signIns(sys), 1);
      assert.ok(out.includes('◇  Sign in to GitHub as example-owner or Second-Owner, for this run only: repo, project, admin:org'), out.join('\n'));
      const login = sys.calls.find((call) => call.command === 'gh' && call.args[1] === 'login')?.args ?? [];
      assert.equal(login[login.indexOf('-s') + 1], 'project,admin:org', 'the sign-in that names the owner asks for the scopes the features need');
    });

    it('refuses a sign-in as an account the owners do not hold, or one that fails', async () => {
      const someone = team();
      someone.acceptToken(OWNER_TOKEN, 'someone');
      assert.deepEqual((await run(someone, [])).err, [
        'onboard: the browser signed in to GitHub as someone, but .github/process-rules.json names the owners example-owner or Second-Owner; sign in there as one of them and run it again',
      ]);
      const failed = team();
      failed.ghToken = undefined;
      assert.deepEqual((await run(failed, [])).err, ['onboard: the GitHub sign-in in the browser did not finish; name the owner: process-rules onboard <owner>']);
    });

    it('takes the owner and agent named, when the lists hold them', async () => {
      const sys = team();
      sys.route('GET', '/users/examplebot', { status: 200, json: { id: AGENT_ID, login: AGENT } });
      const { code, out } = await run(sys, ['EXAMPLE-OWNER', 'examplebot']);
      assert.equal(code, 0);
      assert.equal(repo(sys).get(SETTINGS), `${JSON.stringify(TEAM, null, 2)}\n`);
      assert.ok(out.includes('◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org'), out.join('\n'));
      assert.ok(out.indexOf('◇  Signed in as example-owner') > out.findIndex((line) => line.startsWith('◆')), 'after the plan');
    });

    it('refuses accounts the lists do not hold, and an agent it cannot tell', async () => {
      const outside = team();
      assert.deepEqual((await run(outside, ['someone', AGENT])).err, [
        'onboard: .github/process-rules.json already names owner example-owner or Second-Owner and agent OtherBot or ExampleBot; edit or delete it to change them',
      ]);
      const unset = team();
      unset.files.delete(pathsFor(HOME, AGENT).session);
      assert.deepEqual((await run(unset, [])).err, [
        'onboard: .github/process-rules.json names the agents OtherBot or ExampleBot, and process-rules machine has set up none of them on this machine; name the owner and the agent: process-rules onboard <owner> <agent>',
      ]);
    });
  });

  for (const [release, older] of OLDER_HOOK_COMMANDS.entries()) {
    it(`upgrades an older release's hooks in place (${release})`, async () => {
      const sys = fresh();
      sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: older }] }] } }));
      const { out } = await run(sys);
      assert.ok(planned(out, 'Pull request').includes('settings.json: hooks updated, lock, review rule'), out.join('\n'));
      assert.ok(
        opened(sys)?.body.includes(
          "\n- `.claude/settings.json`: replace the older SessionStart hook that runs process-rules session-start with this release's; " +
            "add the PreToolUse hook that refuses gh and git's remote commands outside the agent identity; " +
            `set GH_TOKEN, GITHUB_TOKEN and ${Object.keys(BASE_ENV).length - 2} more in env, so GitHub is locked out until session-start gives the agent identity; ` +
            'allow process-rules review-thread without a prompt, so agent sessions answer review threads on their own pull requests\n',
        ),
        opened(sys)?.body,
      );
      assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: HOOK_COMMAND }] }], PreToolUse: [GUARD_ENTRY] },
        env: BASE_ENV,
        permissions: { allow: [REVIEW_THREAD_RULE] },
      });
    });
  }

  it('sets only the lock variables that differ, keeping the client\'s own', () => {
    const { text, changes } = claudeSettings(JSON.stringify({ ...CLAUDE, env: { ...BASE_ENV, A: '1', GH_TOKEN: 'mine' } }));
    assert.deepEqual(JSON.parse(text).env, { ...BASE_ENV, A: '1' });
    assert.deepEqual(changes, ['set GH_TOKEN in env, so GitHub is locked out until session-start gives the agent identity']);
  });

  it("adds the review-thread rule to the client's own allow list once", () => {
    const { text, changes } = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: ['Bash(pnpm test)'], deny: ['Read(.env)'] } }));
    assert.deepEqual(JSON.parse(text).permissions, { allow: ['Bash(pnpm test)', REVIEW_THREAD_RULE], deny: ['Read(.env)'] });
    assert.deepEqual(changes, ['allow process-rules review-thread without a prompt, so agent sessions answer review threads on their own pull requests']);
    assert.deepEqual(claudeSettings(text).changes, []);
  });

  it('refuses an env that is not an object, and a file that is not one', () => {
    assert.throws(() => claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: 'all' } })), /^Error: \.claude\/settings\.json: permissions\.allow is not an array$/);
    assert.throws(() => claudeSettings('{ "env": [] }'), /^Error: \.claude\/settings\.json: env is not an object$/);
    assert.throws(() => claudeSettings('[]'), /^Error: \.claude\/settings\.json is not a JSON object$/);
  });

  it("swaps only the older SessionStart command, keeping the file's layout", async () => {
    const sys = fresh();
    const older = JSON.stringify(OLDER_HOOK_COMMANDS[0]);
    const text = `{\r\n    "hooks": {\r\n        "Stop": [ { "hooks": [ { "command": ${older} } ] } ],\r\n        "SessionStart": [ { "hooks": [ { "command": ${older} } ] } ]\r\n    }\r\n}\r\n`;
    sys.files.set(HOOKS, text);
    await run(sys);
    const at = text.lastIndexOf(older);
    const swapped = `${text.slice(0, at)}${JSON.stringify(HOOK_COMMAND)}${text.slice(at + older.length)}`;
    const written = repo(sys).get(HOOKS) ?? '';
    assert.ok(written.startsWith(swapped.slice(0, swapped.lastIndexOf('\r\n    }'))), written);
    assert.ok(written.includes('\r\n        "PreToolUse": [\r\n            {\r\n                "matcher": "Bash",'), 'added in the file\'s own layout');
    assert.deepEqual(JSON.parse(written).env, BASE_ENV);
  });

  it('refuses a settings file it cannot add the hook to, before asking', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '{ "hooks": { "SessionStart": "x" } }');
    await assert.rejects(run(sys), /^Error: \.claude\/settings\.json: hooks\.SessionStart is not an array$/);
    assert.equal(repo(sys).get(HOOKS), '{ "hooks": { "SessionStart": "x" } }');
    assert.deepEqual(sys.chosen, [], 'refused before the plan');
  });

  it("leaves a client's own hook that mentions session-start alone", async () => {
    const sys = fresh();
    const own = 'my-wrapper && process-rules session-start';
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: own }] }] } }));
    await run(sys);
    const commands = JSON.parse(repo(sys).get(HOOKS) ?? '').hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    assert.deepEqual(commands, [own, HOOK_COMMAND]);
  });

  it('changes nothing at a no, opening no pull request and signing in to nothing', async () => {
    for (const answer of ['n', '']) {
      const sys = fresh();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
      sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: OLDER_HOOK_COMMANDS[0] }] }, null, { hooks: 'x' }] } }));
      sys.route('GET', REPO, { status: 404, json: { message: 'Not Found' } });
      sys.answers = [answer];
      const { code, out, err } = await run(sys, []);
      assert.deepEqual({ code, err }, { code: 1, err: [] });
      assert.deepEqual(sys.chosen, ['Go ahead?']);
      assert.equal(out.at(-1), '└  Nothing changed, and no pull request was opened.');
      assert.ok(planned(out, 'GitHub').includes('ExampleBot write access'), out.join('\n'));
      assert.ok(changedNothing(sys), 'nothing written, pushed or signed in to');
      assert.deepEqual(sys.spun, []);
    }
  });

  describe('the hook commands, in a real shell', () => {
    const home = mkdtempSync(join(tmpdir(), 'process-rules-home-'));
    const bin = mkdtempSync(join(tmpdir(), 'process-rules-bin-'));
    const launcher = join(home, '.config/process-rules/bin/process-rules');
    after(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    });
    /** A CLI at `path` that runs `body`. */
    const cli = (path: string, body: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    const shell = (command: string, env: Record<string, string>, input = '') =>
      spawnSync('bash', ['-c', command], { encoding: 'utf8', input, env: { HOME: home, PATH: '/usr/bin:/bin', ...env } });

    it('session-start: its output, in a cloud session too, else STOP with why', () => {
      rmSync(launcher, { force: true });
      cli(join(bin, 'process-rules'), 'echo "ran $* with $(cat)"');
      assert.equal(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: 'true' }, '{}').stdout, 'ran session-start with {}\n');
      assert.equal(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin` }, '{"session_id":"s"}').stdout, 'ran session-start with {"session_id":"s"}\n');
      assert.match(
        shell(HOOK_COMMAND, {}).stdout,
        /^process-rules: STOP\. process-rules session-start did not run here \(.*process-rules: (?:command )?not found\), so this session cannot be given the agent identity and GitHub is locked out of it\./,
      );
      cli(launcher, 'echo "env: node: No such file or directory" >&2; exit 127');
      assert.match(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin` }).stdout, /^process-rules: STOP\. process-rules session-start did not run here \(env: node: No such file or directory\)/);
      cli(launcher, 'echo "launched $*"');
      assert.equal(shell(HOOK_COMMAND, {}).stdout, 'launched session-start\n', 'the launcher, with nothing on PATH');
    });

    it('pre-push: the owner\'s pushes go ahead; an agent session\'s runs the CLI, refused without one', () => {
      rmSync(launcher, { force: true });
      const hook = (env: Record<string, string>) => spawnSync('sh', ['-c', `${PRE_PUSH_HOOK}`, 'pre-push', 'origin', 'url'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', ...env } });
      assert.equal(hook({}).status, 0);
      for (const env of [{ CLAUDECODE: '1' }, { PROCESS_RULES_AGENT: AGENT }, { CLAUDECODE: '1', CLAUDE_CODE_REMOTE: 'true' }]) {
        const refused = hook(env);
        assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 1, stderr: 'process-rules: the CLI is not installed, so this agent push cannot be checked\n' });
      }
      cli(launcher, 'echo "ran $*"; exit 1');
      assert.deepEqual((({ status, stdout }) => ({ status, stdout }))(hook({ CLAUDECODE: '1' })), { status: 1, stdout: 'ran pre-push origin url\n' });
      cli(launcher, 'exit 0');
      assert.equal(hook({ CLAUDECODE: '1' }).status, 0);
    });

    it('guard: commands naming neither gh nor git go ahead without the CLI; others as the CLI says, refused when it cannot run', () => {
      rmSync(launcher, { force: true });
      const input = (command: string): string => JSON.stringify({ session_id: 's', tool_input: { command } });
      assert.equal(shell(GUARD_COMMAND, {}, input('ls')).status, 0);
      assert.equal(shell(GUARD_COMMAND, {}, input('ls .github && echo high')).status, 0, 'gh and git as words only');
      assert.equal(shell(GUARD_COMMAND, {}, input('/usr/bin/gh pr list')).status, 2);
      const described = JSON.stringify({ session_id: 's', cwd: '/x/github', tool_input: { command: 'echo "git"x', description: 'Run gh' } });
      assert.equal(shell(GUARD_COMMAND, {}, described.replace('echo \\"git\\"x', 'ls')).status, 0, 'only the command counts');
      assert.equal(shell(GUARD_COMMAND, {}, described).status, 2, 'escaped quotes inside the command');
      assert.equal(shell(GUARD_COMMAND, {}, '{ "tool_input": { "command": "echo \\"a\\" && gh pr list" } }').status, 2);
      const missing = shell(GUARD_COMMAND, {}, input('git push'));
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /process-rules: refused, because the process-rules CLI did not run here to check this command\./);
      assert.equal(shell(GUARD_COMMAND, { CLAUDE_CODE_REMOTE: 'true' }, input('git push')).status, 2, 'in a cloud session too');
      cli(launcher, 'cat > "$HOME/seen"; exit 0');
      assert.equal(shell(GUARD_COMMAND, {}, input('gh pr list')).status, 0);
      assert.equal(readFileSync(join(home, 'seen'), 'utf8'), input('gh pr list'));
      cli(launcher, 'echo "process-rules: refused, why" >&2; exit 2');
      assert.deepEqual(
        (({ status, stderr }) => ({ status, stderr }))(shell(GUARD_COMMAND, {}, input('gh pr list'))),
        { status: 2, stderr: 'process-rules: refused, why\n' },
      );
      cli(launcher, 'exit 1');
      assert.equal(shell(GUARD_COMMAND, {}, input('gh pr list')).status, 2);
    });
  });

  it('adds the hook when the command only appears elsewhere', async () => {
    const sys = fresh();
    const lookalike = { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }], SessionStart: [{ hooks: [{ command: 'echo process-rules is set up elsewhere' }] }, {}] } };
    sys.files.set(HOOKS, JSON.stringify(lookalike));
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('settings.json: hooks added, lock, review rule'), out.join('\n'));
    assert.match(opened(sys)?.body ?? '', /^- `\.claude\/settings\.json`: add the SessionStart hook/m);
    assert.equal(JSON.parse(repo(sys).get(HOOKS) ?? '').hooks.SessionStart.length, 3);
  });

  it('uses GitHub\'s spelling of the accounts existing settings name', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'Example-Owner', agent: 'examplebot' }));
    sys.route('GET', '/users/Example-Owner', { status: 200, json: { id: 1, login: 'example-owner' } });
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.ok(out.includes('│  example-org/example-app · owner example-owner · agent ExampleBot'), out.join('\n'));
    assert.ok(out.includes('◇  test commit Verified as ExampleBot'));
  });

  it('refuses a repository with no commits, before pushing anything', async () => {
    const sys = fresh();
    sys.remoteHead = '';
    const { code, out, err } = await run(sys);
    assert.deepEqual({ code, err }, {
      code: 1,
      err: [
        'onboard: example-org/example-app has no commits yet; push a first commit to it, then onboard again',
        'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened',
      ],
    });
    assert.ok(out.includes('■  test commit Verified as ExampleBot'));
    assert.ok(!out.some((line) => line.startsWith('└')), 'no ending');
    assert.ok(!sys.calls.some((c) => c.args[0] === 'push'));
  });

  it('keeps the hooks a client already has', async () => {
    const sys = fresh();
    const own = { hooks: [{ type: 'command', command: 'echo hi' }] };
    sys.files.set(HOOKS, JSON.stringify({ env: { A: '1' }, hooks: { SessionStart: [own], Stop: [own] } }));
    await run(sys);
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), {
      env: { A: '1', ...BASE_ENV },
      hooks: { SessionStart: [own, SESSION_ENTRY], Stop: [own], PreToolUse: [GUARD_ENTRY] },
      permissions: { allow: [REVIEW_THREAD_RULE] },
    });
  });

  it("replaces an older release's pre-push hook", async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, OLDER_PRE_PUSH_HOOKS[0] as string);
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'This Mac'), ['pre-push hook: older one replaced']);
    assert.match(opened(sys)?.body ?? '', /^ {2}- replaced the older pre-push git hook \.git\/hooks\/pre-push, which checks/m);
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
  });

  it("leaves the client's own pre-push hook, naming the line to add", async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, '#!/bin/sh\nnpm test\n');
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'This Mac'), []);
    assert.ok(byHand(out).includes('add process-rules pre-push "$@" → .git/hooks/pre-push'), out.join('\n'));
    assert.ok(opened(sys)?.body.includes('\n- Add the line `process-rules pre-push "$@"` to the pre-push git hook .git/hooks/pre-push, which is your own.\n'), 'the pull request lists it too');
    assert.equal(sys.files.get(PRE_PUSH), '#!/bin/sh\nnpm test\n');
  });

  it('writes the hook where git keeps hooks inside the repository', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[1] === '--git-path' ? { code: 0, stdout: `${ROOT}/.git/hooks/pre-push\n`, stderr: '' } : undefined);
    await run(sys);
    assert.equal(sys.files.get(`${ROOT}/.git/hooks/pre-push`), PRE_PUSH_HOOK);
  });

  it('leaves a hooks folder shared by other repositories alone, naming the line to add', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[1] === '--git-path' ? { code: 0, stdout: '/shared/hooks/pre-push\n', stderr: '' } : undefined);
    const { out } = await run(sys);
    assert.ok(byHand(out).includes('add process-rules pre-push "$@" → /shared/hooks/pre-push'), out.join('\n'));
    assert.ok(!sys.files.has('/shared/hooks/pre-push'));
  });

  it('counts only a hook line that runs the rules, not a mention', async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, '#!/bin/sh\n# TODO: process-rules pre-push\n');
    assert.ok(byHand((await run(sys)).out).includes('add process-rules pre-push "$@" → .git/hooks/pre-push'));
    const ours = fresh();
    ours.files.set(PRE_PUSH, '#!/bin/sh\nnpm test\n  process-rules pre-push "$@"\n');
    const { out } = await run(ours);
    assert.deepEqual(planned(out, 'This Mac'), []);
    assert.ok(!byHand(out).some((line) => line.includes('pre-push')));
  });

  it('replaces a workflow that differs', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, 'old');
    sys.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('workflow: replaced'), out.join('\n'));
    assert.match(repo(sys).get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
  });

  it("replaces an older release's single-job workflow, saying why", async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, olderWorkflows('main', '0.5.2')[0] as string);
    const { out } = await run(sys);
    assert.equal(out[0], `◆  process-rules onboard   v0.5.2 → v${packageVersion()}`);
    assert.ok(planned(out, 'Pull request').includes('workflow: older template replaced'), out.join('\n'));
    assert.match(opened(sys)?.body ?? '', /^- `\.github\/workflows\/process-rules\.yml`: replace the older \.github\/workflows\/process-rules\.yml, which lets every run write to issues/m);
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true));
  });

  it('moves only the version pins of a workflow already split', async () => {
    const sys = fresh();
    const own = workflow('main', '0.5.2', true).replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes(`workflow: pins → v${packageVersion()}`), out.join('\n'));
    assert.ok(opened(sys)?.body.includes(`in .github/workflows/process-rules.yml, move the version pins from v0.5.2 to v${packageVersion()}, leaving the rest as it is`));
    assert.equal(repo(sys).get(WORKFLOW), own.replaceAll('0.5.2', packageVersion()));
  });

  it('leaves a split workflow at this release alone', async () => {
    const sys = fresh();
    const own = workflow('main', packageVersion(), true).replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { out } = await run(sys);
    assert.ok(!planned(out, 'Pull request').some((item) => item.startsWith('workflow')), out.join('\n'));
    assert.equal(repo(sys).get(WORKFLOW), own);
  });

  it('refuses inside an agent session', async () => {
    const sys = fresh();
    sys.env.PROCESS_RULES_AGENT = AGENT;
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['onboard: run it in your own terminal, not in an agent session'] });
  });

  for (const [name, named, change, message] of [
    [
      'without accounts the first time, when this Mac suggests none',
      [],
      (sys: FakeSys) => {
        sys.ghToken = undefined;
        sys.answers = ['', ''];
      },
      'onboard: name the owner and the agent account: process-rules onboard <owner> <agent>',
    ],
    ['the same account twice', ['example-owner', 'Example-Owner'], () => undefined, 'onboard: the owner and the agent must be different accounts'],
    [
      'accounts other than the settings name',
      ['someone', AGENT],
      (sys: FakeSys) => sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT })),
      'onboard: .github/process-rules.json already names owner example-owner and agent ExampleBot; edit or delete it to change them',
    ],
    [
      'a Mac not set up for the agent',
      ['example-owner', AGENT],
      (sys: FakeSys) => sys.keychain.clear(),
      'onboard: this Mac is not set up for ExampleBot (no token stored for ExampleBot); run process-rules machine ExampleBot, then onboard again',
    ],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      sys.route('GET', '/users/Example-Owner', { status: 200, json: { id: 1, login: 'example-owner' } });
      change(sys);
      const { code, err } = await run(sys, [...named]);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
    });
  }

  describe('finding the accounts', () => {
    /** A Mac where machine set up the agent, and the owner's browser approves the sign-in. */
    function setUp(agents: string[]): FakeSys {
      const sys = fresh();
      for (const agent of agents) {
        sys.files.set(`${sys.home}/.config/process-rules/${agent.toLowerCase()}/session.sh`, sessionScript(agent, 42, pathsFor(sys.home, agent)));
      }
      sys.files.set(`${sys.home}/.config/process-rules/locked/gh/hosts.yml`, '');
      return sys;
    }

    it("takes the one-run sign-in's login as owner and the one agent set up here, with Enter", async () => {
      const sys = setUp([AGENT]);
      sys.answers = ['', '', 'y'];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.equal(out[0], '◇  Sign in to GitHub as the owner, for this run only: repo, project, admin:org', 'no owner is known before the sign-in, which comes before the plan');
      assert.match(opened(sys)?.body ?? '', /^- onboard signed in before showing its plan, to suggest the owner by the account the browser signed in as\.$/m);
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').owner, 'example-owner');
      assert.equal(signIns(sys), 1, 'the sign-in that suggested the owner serves the board too');
    });

    it('lists the agents set up here and takes what is typed', async () => {
      const sys = setUp(['OtherBot', AGENT]);
      sys.answers = ['', 'examplebot', 'y'];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.ok(out.includes('Accounts set up here for the agent: OtherBot, ExampleBot'));
      assert.equal(JSON.parse(repo(sys).get(SETTINGS) ?? '').agent, AGENT);
    });

    it('suggests no owner when the sign-in fails or GitHub will not answer', async () => {
      const sys = setUp([AGENT]);
      sys.ghToken = 'gho_unknown';
      sys.answers = ['', ''];
      assert.deepEqual((await run(sys, [])).err, ['onboard: name the owner and the agent account: process-rules onboard <owner> <agent>']);
      assert.equal(sys.asked[0], 'The owner, who approves: ');
      const down = setUp([AGENT]);
      down.http = () => Promise.reject(new Error('offline'));
      down.answers = ['', ''];
      assert.deepEqual((await run(down, [])).err, ['onboard: name the owner and the agent account: process-rules onboard <owner> <agent>']);
      assert.equal(down.asked[0], 'The owner, who approves: ');
    });
  });

  describe("the owner's one-run sign-in", () => {
    /** The scopes onboard's sign-in asked gh for, one list per sign-in. */
    const asked = (sys: FakeSys): string[][] =>
      sys.calls.filter((c) => c.args[1] === 'login').map((c) => (c.args.includes('-s') ? (c.args[c.args.indexOf('-s') + 1] ?? '').split(',') : []));

    it("signs in once, for the board's scopes, with the owner's gh folder untouched and the temporary one gone", async () => {
      const sys = fresh();
      sys.files.set(`${sys.home}/.config/gh/hosts.yml`, 'github.com:\n    oauth_token: gho_owners_own\n');
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(asked(sys), [['project', 'admin:org']]);
      const line = out.indexOf('◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org');
      assert.ok(line >= 0, out.join('\n'));
      // gh's code and link, without its lines about the temporary folder's setup.
      assert.deepEqual(out.slice(line + 1, line + 4), ['│  one-time code 1881-F156 (copied)', '│  approve it at https://github.com/login/device', '◇  Signed in as example-owner']);
      assert.ok(!out.some((text) => /plain text|git protocol|Logged in as|Authentication complete/.test(text)), out.join('\n'));
      assert.deepEqual(sys.removed, sys.temps);
      const gh = sys.calls.filter((c) => c.command === 'gh');
      assert.ok(gh.length > 0 && gh.every((c) => c.env?.GH_CONFIG_DIR === sys.temps[0]), "gh never runs on the owner's own folder");
      assert.equal(sys.files.get(`${sys.home}/.config/gh/hosts.yml`), 'github.com:\n    oauth_token: gho_owners_own\n');
      assert.ok(!sys.requests.some((r) => r.token === 'gho_owners_own'));
    });

    it('asks a personal repository for projects alone', async () => {
      const sys = fresh();
      sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'User' } });
      sys.route('GET', REPO, { status: 200, json: repoJson(false) });
      sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, project' });
      assert.equal((await run(sys)).code, 0);
      assert.deepEqual(asked(sys), [['project']]);
    });

    it('does not sign in when no step needs the owner', async () => {
      const sys = fresh();
      assert.equal((await run(sys, ['example-owner', AGENT, '--features', 'identity,pr-identity'])).code, 0);
      assert.equal(signIns(sys), 0);
    });

    it("signs in for the board's scopes when --add turns it on", async () => {
      const sys = fresh();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
      assert.equal((await run(sys, ['--add', 'board'])).code, 0);
      assert.deepEqual(asked(sys), [['project', 'admin:org']]);
      assert.deepEqual(sys.removed, sys.temps);
    });

    for (const [name, change, message] of [
      ['a sign-in as someone else', (sys: FakeSys) => sys.acceptToken(OWNER_TOKEN, 'someone'), 'onboard: the browser signed in to GitHub as someone, not the owner example-owner; sign in to github.com there as example-owner and run it again'],
      ['a sign-in turned down', (sys: FakeSys) => (sys.ghToken = undefined), 'onboard: the GitHub sign-in in the browser did not finish'],
    ] as const) {
      it(`stops at ${name}, with the temporary folder gone`, async () => {
        const sys = fresh();
        change(sys);
        const { code, err } = await run(sys);
        assert.deepEqual({ code, err }, { code: 1, err: [message, 'onboard: stopped at "board"; nothing after it was changed, and no pull request was opened'] });
        assert.equal(sys.temps.length, 1);
        assert.deepEqual(sys.removed, sys.temps);
        assert.ok(!sys.requests.some((r) => /\/labels|\/issue-types|\/graphql$/.test(r.url)), 'the board is not touched');
      });
    }
  });

  describe('a personal repository', () => {
    /** A repository a personal account owns: GitHub gives it no issue types. */
    function personal(): FakeSys {
      const sys = fresh();
      sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'User' } });
      sys.route('GET', REPO, { status: 200, json: repoJson(false) });
      sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, project' });
      return sys;
    }
    const WHY = 'example-org/example-app is owned by a personal account, and GitHub has issue types for organisations only';

    it('gets the features it can run when none are named, saying which it left off', async () => {
      const sys = personal();
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.equal(out[2], '│  ! personal account: work-rules, figma, decisions left off');
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'pr-identity', 'board', 'review']);
      assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
    });

    it('refuses --features that need issue types, writing nothing', async () => {
      const sys = personal();
      const { code, err } = await run(sys, ['example-owner', AGENT, '--features', 'board,work-rules']);
      assert.deepEqual({ code, err }, { code: 1, err: [`onboard: ${WHY}, so work-rules cannot run here; leave it out of --features`] });
      assert.equal(repo(sys).get(SETTINGS), undefined);
      const both = personal();
      assert.deepEqual((await run(both, ['example-owner', AGENT, '--features', 'decisions,figma'])).err, [`onboard: ${WHY}, so figma, decisions cannot run here; leave them out of --features`]);
    });

    it('takes --features that need no issue types', async () => {
      const sys = personal();
      assert.equal((await run(sys, ['example-owner', AGENT, '--features', 'pr-identity'])).code, 0);
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'pr-identity']);
    });

    for (const feature of ['work-rules', 'figma', 'decisions']) {
      it(`refuses --add ${feature}, changing nothing`, async () => {
        const sys = personal();
        const settings = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] });
        sys.files.set(SETTINGS, settings);
        const { code, err } = await run(sys, ['--add', feature]);
        assert.deepEqual({ code, err }, { code: 1, err: [`onboard: ${WHY}, so ${feature} cannot run here`] });
        assert.equal(repo(sys).get(SETTINGS), settings);
        assert.deepEqual(sys.chosen, []);
      });
    }

    it('refuses --add before renaming an older feature, changing nothing', async () => {
      const sys = personal();
      const settings = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] });
      sys.files.set(SETTINGS, settings);
      assert.equal((await run(sys, ['--add', 'work-rules'])).code, 1);
      assert.equal(repo(sys).get(SETTINGS), settings);
      assert.deepEqual(sys.chosen, []);
    });

    it('names the features its settings list that cannot run there', async () => {
      const sys = personal();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'decisions'] }));
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.equal(out[2], '│  ! decisions: organisations only; take it out of features');
    });

    it('asks GitHub once whether an organisation owns it', async () => {
      const sys = personal();
      await run(sys);
      assert.equal(sys.requests.filter((r) => r.url.endsWith('/users/example-org')).length, 1);
    });
  });

  describe("keeping the client's settings layout", () => {
    it('adds only its entries to an existing file', async () => {
      const sys = fresh();
      const text = '{\n  "env": { "A": "1" },\n  "hooks": {\n    "Stop": [{ "hooks": [] }]\n  }\n}\n';
      sys.files.set(HOOKS, text);
      await run(sys);
      const out = repo(sys).get(HOOKS) ?? '';
      assert.ok(out.startsWith('{\n  "env": { "A": "1",'), out);
      assert.ok(out.includes('\n  "hooks": {\n    "Stop": [{ "hooks": [] }],\n    "SessionStart": ['), out);
      assert.deepEqual(JSON.parse(out), { env: { A: '1', ...BASE_ENV }, hooks: { Stop: [{ hooks: [] }], SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, permissions: { allow: [REVIEW_THREAD_RULE] } });
    });

    it("swaps an older release's command in the text", async () => {
      const sys = fresh();
      const older = OLDER_HOOK_COMMANDS[0] as string;
      sys.files.set(HOOKS, `{ "env": { "A": "1" }, "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(older)} }] }] } }\n`);
      await run(sys);
      assert.ok((repo(sys).get(HOOKS) ?? '').includes(`"SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(HOOK_COMMAND)} }] }]`));
    });
  });

  it('refuses a name that is not a login', async () => {
    await assert.rejects(run(fresh(), ['-x', AGENT]), /"-x" is not a GitHub login/);
  });

  it('refuses hooks settings that are not an object', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '[]');
    await assert.rejects(run(sys), /\.claude\/settings\.json is not a JSON object/);
  });

  it('refuses a Mac whose key is missing', async () => {
    const sys = fresh();
    sys.files.delete(`${sys.home}/.ssh/examplebot_signing`);
    assert.equal((await run(sys)).code, 1);
  });

  describe('agent access', () => {
    it("gives an organisation member access with the owner's one-run token", async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
      sys.route('PUT', COLLABORATOR, () => {
        added = true;
        return { status: 204, json: null };
      });
      const { code } = await run(sys);
      assert.equal(code, 0);
      const put = sys.requests.find((r) => r.method === 'PUT');
      assert.deepEqual([put?.token, put?.body], [OWNER_TOKEN, { permission: 'push' }]);
      assert.equal(signIns(sys), 1, 'one sign-in for the access and the board');
    });

    it('plans either merge until the agent can push, then asks the default branch for a merge queue', async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? { status: 200, json: { ...repoJson(), allow_auto_merge: false } } : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
      sys.route('PUT', COLLABORATOR, () => {
        added = true;
        return { status: 204, json: null };
      });
      const config = 'queue_rules:\n  - name: default\nmerge_protections_settings:\n  auto_merge_conditions: true\n';
      sys.route('GET', `${REPO}/contents/.mergify.yml?ref=main`, () => (added ? { status: 200, json: { content: Buffer.from(config).toString('base64') } } : { status: 404, json: null }));
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.ok(planned(out, 'Pull request').includes('auto-merge or merge queue: when checks pass'), out.join('\n'));
      assert.ok(out.includes(`└  ${PULL_URL}  the merge queue merges it when checks pass`), out.join('\n'));
      assert.ok(!byHand(out).some((line) => line.startsWith('auto-merge')));
    });

    it('invites, then accepts the invitation as the agent', async () => {
      const sys = fresh();
      let accepted = false;
      let invited = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', () => ({
        status: 200,
        json: invited ? [{ id: 9, repository: { full_name: 'Example-Org/Example-App' } }, { id: 'x' }, null] : [],
      }));
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      sys.route('PUT', COLLABORATOR, () => {
        invited = true;
        return { status: 201, json: {} };
      });
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.equal(sys.requests.find((r) => r.method === 'PATCH')?.token, TOKEN);
      assert.ok(planned(out, 'GitHub — one sign-in').includes('ExampleBot write access'), out.join('\n'));
      assert.ok(out.includes('◇  ExampleBot can push'));
    });

    it('offers write access to an agent that can only read, then accepts the invitation', async () => {
      const sys = fresh();
      let accepted = false;
      let invited = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 200, json: { ...repoJson(), permissions: { push: false } } }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', () => ({
        status: 200,
        json: invited ? [{ id: 9, repository: { full_name: 'example-org/example-app' } }] : [],
      }));
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      sys.route('PUT', COLLABORATOR, () => {
        invited = true;
        return { status: 201, json: {} };
      });
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.ok(invited, 'grants write access');
      const body = opened(sys)?.body ?? '';
      assert.ok(body.includes('\n- ExampleBot can push:\n  - gave ExampleBot, which can read but not push to example-org/example-app, write access, as example-owner\n'), body);
      assert.ok(body.includes("\n  - accepted ExampleBot's invitation to example-org/example-app, as ExampleBot\n"), body);
    });

    it('finds an invitation on a later page', async () => {
      const sys = fresh();
      let accepted = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      const others = Array.from({ length: 100 }, (_, i) => ({ id: i, repository: { full_name: `example-org/other-${i}` } }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: others });
      sys.route('GET', '/user/repository_invitations?per_page=100&page=2', { status: 200, json: [{ id: 900, repository: { full_name: 'example-org/example-app' } }] });
      sys.route('PATCH', '/user/repository_invitations/900', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      assert.equal((await run(sys)).code, 0);
    });

    it('accepts a pending invitation without inviting again', async () => {
      const sys = fresh();
      let accepted = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
      assert.equal(code, 0);
      assert.ok(!sys.requests.some((r) => r.method === 'PUT'), 'invites no one');
      assert.deepEqual(planned(out, 'GitHub'), ['ExampleBot accepts its invitation']);
      assert.ok(out.includes('◇  GitHub'), 'no sign-in: the agent accepts it');
      assert.equal(signIns(sys), 0);
    });

    for (const [name, setUp, message] of [
      [
        'GitHub refusing to add the agent',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 500, json: null });
          sys.route('PUT', COLLABORATOR, { status: 403, json: { message: 'Must have admin rights to Repository.' } });
        },
        ['onboard: GitHub did not add ExampleBot (HTTP 403: Must have admin rights to Repository.)', '  Add it yourself: example-org/example-app → Settings → Collaborators → Add people → ExampleBot, role Write.'],
      ],
      [
        'an invitation GitHub will not accept',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
          sys.route('PATCH', '/user/repository_invitations/9', { status: 403, json: null });
        },
        ['onboard: GitHub did not accept the invitation (HTTP 403)'],
      ],
      [
        'an agent still without access',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
          sys.route('PUT', COLLABORATOR, { status: 204, json: null });
        },
        ['onboard: ExampleBot still cannot see example-org/example-app; check the invitation reached ExampleBot'],
      ],
      [
        'an agent still read-only',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 200, json: { ...repoJson(), permissions: { push: false } } });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
          sys.route('PUT', COLLABORATOR, { status: 204, json: null });
        },
        ['onboard: ExampleBot can read example-org/example-app but still not push; check the invitation reached ExampleBot, or give it the Write role'],
      ],
      [
        'an organisation requiring SAML',
        (sys: FakeSys) =>
          sys.route('GET', REPO, {
            status: 403,
            json: { message: 'Resource protected by organization SAML enforcement.' },
            headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example-org/sso?authorization_request=abc' },
          }),
        ['onboard: the organisation requires SAML single sign-on; authorise the token for it at https://github.com/orgs/example-org/sso?authorization_request=abc'],
      ],
      [
        'an organisation blocking classic tokens',
        (sys: FakeSys) =>
          sys.route('GET', REPO, {
            status: 403,
            json: { message: 'example-org forbids access via a personal access tokens (classic).' },
          }),
        [
          'onboard: the organisation does not allow classic tokens ("example-org forbids access via a personal access tokens (classic)."); an organisation owner can allow them under Settings → Personal access tokens',
        ],
      ],
      [
        'any other refusal',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 401, json: null }),
        ['onboard: GitHub refused (HTTP 401)'],
      ],
      [
        'a refusal with a message',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 451, json: { message: 'blocked' } }),
        ['onboard: GitHub refused (HTTP 451: blocked)'],
      ],
    ] as const) {
      it(`names ${name}`, async () => {
        const sys = fresh();
        setUp(sys);
        const { code, err } = await run(sys);
        // Found while planning, a refusal stops before the plan; found after the yes, it stops that step.
        const planning = !message[0]?.includes('ExampleBot') && !message[0]?.includes('invitation');
        assert.deepEqual({ code, err }, {
          code: 1,
          err: [...message, ...(planning ? [] : ['onboard: stopped at "ExampleBot can push"; nothing after it was changed, and no pull request was opened'])],
        });
        assert.equal(sys.chosen.length, planning ? 0 : 1);
      });
    }
  });

  describe('test commit', () => {
    it('deletes the branch even when GitHub cannot be asked', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, () => {
        throw new Error('down');
      });
      const { code, out, err } = await run(sys);
      assert.equal(code, 1);
      assert.deepEqual(err, ['onboard: cannot ask GitHub whether the test commit is Verified (down); open the link above to see', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened']);
      assert.ok(out.includes('│  Test commit https://github.com/example-org/example-app/commit/abc123'), out.join('\n'));
      assert.ok(out.includes('│  Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
      assert.deepEqual(sys.slept, [2000, 4000, 6000, 8000]);
      assert.equal(sys.calls.at(-1)?.command, 'rm');
    });

    it('asks again when GitHub cannot be asked for a moment, and prints the result', async () => {
      const sys = fresh();
      const answers: (() => HttpResult)[] = [
        () => {
          throw new Error('fetch failed');
        },
        () => ({ status: 422, json: { message: 'No commit found' } }),
        () => VERIFIED,
      ];
      sys.route('GET', `${REPO}/commits/abc123`, () => (answers.shift() as () => HttpResult)());
      const { code, out, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 0, err: [] });
      assert.ok(out.includes('◇  test commit Verified as ExampleBot'));
      assert.ok(opened(sys)?.body.includes('\n  - GitHub shows the test commit Verified by ExampleBot\n'));
      assert.deepEqual(sys.slept, [2000, 4000]);
    });

    it('names the last answer when GitHub keeps refusing', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, { status: 502, json: null });
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: cannot ask GitHub whether the test commit is Verified (HTTP 502); open the link above to see', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened'] });
    });

    it('says so when the branch cannot be deleted', async () => {
      const sys = fresh();
      sys.execOverride = (call) =>
        call.command === 'git' && call.args[3]?.startsWith(':') ? { code: 1, stdout: '', stderr: 'protected\n' } : undefined;
      const { code, err } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(err, ['onboard: could not delete process-rules/verify-examplebot-1793361600000; delete it on GitHub: protected']);
    });

    for (const [args, message] of [
      ['init', 'onboard: git init failed: boom'],
      ['fetch', 'onboard: git fetch failed: boom'],
      ['commit-tree', 'onboard: signing the test commit failed: boom'],
      ['push', 'onboard: pushing as ExampleBot failed: boom'],
    ] as const) {
      it(`reports a failed git ${args} and cleans up`, async () => {
        const sys = fresh();
        sys.execOverride = (call) =>
          call.command === 'git' && call.args[0] === args ? { code: 1, stdout: '', stderr: 'boom\n' } : undefined;
        const { code, err } = await run(sys);
        assert.deepEqual({ code, err }, { code: 1, err: [message, 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened'] });
        assert.equal(sys.calls.at(-1)?.command, 'rm');
      });
    }

    for (const [name, json, shown] of [
      ['unverified', { committer: { login: AGENT }, commit: { verification: { verified: false, reason: 'unknown_key' } } }, `committer: ${AGENT}; verified: false (unknown_key)`],
      ['committed by someone else', { committer: { login: 'example-owner' }, commit: { verification: { verified: true, reason: 'valid' } } }, 'committer: example-owner; verified: true (valid)'],
      ['unreadable', null, 'committer: none; verified: undefined (no reason)'],
    ] as const) {
      it(`fails a test commit that is ${name}`, async () => {
        const sys = fresh();
        sys.route('GET', `${REPO}/commits/abc123`, { status: 200, json });
        const { code, out, err } = await run(sys);
        assert.equal(code, 1);
        assert.ok(out.includes(`│  ${shown}`), out.join('\n'));
        assert.deepEqual(err, ['onboard: GitHub does not show the commit Verified by ExampleBot', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened']);
      });
    }
  });

});

describe('staged adoption', () => {
  it('sets up identity alone, with the pre-push hook but no workflow or board', async () => {
    const sys = fresh();
    const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity']);
    assert.ok(repo(sys).has(HOOKS));
    assert.ok(!repo(sys).has(WORKFLOW));
    assert.ok(repo(sys).has(CLOUD), 'cloud sessions, for every adopter');
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK, 'the identity guard, for every adopter');
    const boardRequest = (r: { url: string; body?: unknown }): boolean =>
      (r.url.endsWith('/graphql') && !JSON.stringify(r.body).includes('enablePullRequestAutoMerge')) || r.url.includes('/labels') || r.url.includes('/issue-types');
    assert.ok(!sys.requests.some(boardRequest), 'no board');
    assert.deepEqual(planned(out, 'Pull request'), ['process-rules.json: new, 1 feature on', 'settings.json: new', `cloud-setup.sh: new, installs v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.deepEqual(planned(out, 'GitHub'), [], 'no board, and the agent can push');
    assert.deepEqual(planned(out, 'This Mac'), ['pre-push hook: new']);
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.deepEqual([...sys.committed.keys()], ['.github/process-rules.json', '.claude/settings.json', CLOUD_SETUP_PATH]);
    assert.deepEqual(byHand(out), ["cloud sessions, once: claude.ai's GitHub as ExampleBot, Setup script from process-rules cloud-setup, first"]);
    assert.deepEqual(sys.chosen, ['Go ahead?']);
  });

  it('turns one more feature on, keeping the other settings', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], project: 'Example work', note: 'kept' }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    const board = new Board(sys);
    const { code, out } = await run(sys, ['--add', 'board']);
    assert.equal(code, 0);
    assert.deepEqual(board.titles, ['Example work']);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), {
      owner: 'example-owner',
      agent: AGENT,
      features: ['identity', 'board'],
      project: 'Example work',
      note: 'kept',
    });
    assert.deepEqual(planned(out, 'Pull request'), ['process-rules.json: turn board on', `cloud-setup.sh: new, installs v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.ok(planned(out, 'GitHub — one sign-in as example-owner').includes('board: set up or check'));
    assert.ok(!repo(sys).has(WORKFLOW), 'board alone needs no workflow');
  });

  it('renames design to figma, takes the library key out of older settings and sets it as the FIGMA_LIBRARY secret', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'], figma: { library: 'LibKey0123abc' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const pair = await actionsKey(sys);
    const { code, out, err } = await run(sys);
    assert.deepEqual([code, err], [0, []]);
    assert.deepEqual(planned(out, 'Pull request'), ['process-rules.json: design → figma, figma key out', 'workflow: new', `cloud-setup.sh: new, installs v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.deepEqual(planned(out, 'GitHub — one sign-in as example-owner'), ['FIGMA_LIBRARY secret']);
    assert.match(
      opened(sys)?.body ?? '',
      /^- `\.github\/process-rules\.json`: rename the design feature to figma and take out "figma" and set its library key as the FIGMA_LIBRARY Actions secret$/m,
    );
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] });
    const sent = sealedValue(sys, pair);
    assert.deepEqual([sent.value, sent.keyId, sent.token], ['LibKey0123abc', 'key-1', OWNER_TOKEN], "sealed with the repository's key, as the owner for this run");
    assert.equal(signIns(sys), 1);
    assert.ok(out.includes('◇  FIGMA_LIBRARY secret'));
    const said = [...out, ...err, ...sys.asked, opened(sys)?.body ?? ''];
    assert.ok(!said.some((line) => line.includes('LibKey0123abc')), 'the key never appears in the output');
    assert.ok(!said.some((line) => /\bgh (secret|auth|api)\b/.test(line)), 'the owner is never told to run gh');
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true));
  });

  it('stops when the FIGMA_LIBRARY secret cannot be set, saying why without the key', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'LibKey0123abc' } }));
    await actionsKey(sys, { status: 403, json: { message: 'Must have admin rights to Repository.' } });
    const { code, out, err } = await run(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      'onboard: GitHub did not set the FIGMA_LIBRARY secret (HTTP 403: Must have admin rights to Repository.)',
      'onboard: stopped at "FIGMA_LIBRARY secret"; nothing after it was changed, and no pull request was opened',
    ]);
    assert.ok(out.includes('■  FIGMA_LIBRARY secret'));
    assert.ok(![...out, ...err].some((line) => line.includes('LibKey0123abc')));
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')));
  });

  it('stops when the owner does not sign in to set the FIGMA_LIBRARY secret', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'LibKey0123abc' } }));
    sys.ghToken = undefined;
    const { code, err } = await run(sys);
    assert.deepEqual([code, err], [1, ['onboard: the GitHub sign-in in the browser did not finish', 'onboard: stopped at "FIGMA_LIBRARY secret"; nothing after it was changed, and no pull request was opened']]);
    assert.ok(!sys.requests.some((r) => r.method === 'PUT'));
  });

  it('renames design alone, and stops at a no', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] }));
    sys.answers = ['n'];
    const { code, out } = await run(sys);
    assert.equal(code, 1);
    assert.ok(planned(out, 'Pull request').includes('process-rules.json: design → figma'), out.join('\n'));
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'design']);
    assert.ok(changedNothing(sys));
  });

  it('takes out a library key from settings that list no features', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, figma: {} }));
    const { out } = await run(sys);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: AGENT });
    assert.ok(!out.some((line) => line.includes('gh secret set')));
  });

  it('says when a workflow of its own passes no FIGMA_LIBRARY with figma on', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const own = workflow('main', packageVersion(), true).replaceAll('      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n', '      OTHER: ${{ secrets.OTHER }}\n');
    sys.files.set(WORKFLOW, own);
    const { out } = await run(sys);
    assert.equal(repo(sys).get(WORKFLOW), own);
    assert.ok(byHand(out).includes('pass FIGMA_LIBRARY in process-rules, process-rules-weekly, process-rules-merged, process-rules-asks → .github/workflows/process-rules.yml'), out.join('\n'));
    assert.ok(opened(sys) === undefined || opened(sys)?.body.includes('pass the shared checks no FIGMA_LIBRARY secret'));
    // A workflow the pull request replaces passes it: nothing to do by hand then, though the plan was made without the branch.
    const replaced = fresh();
    replaced.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    replaced.files.set(WORKFLOW, 'old');
    let added = false;
    replaced.route('GET', REPO, () => (added ? PUSH : { status: 404, json: null }));
    replaced.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    replaced.route('PUT', COLLABORATOR, () => {
      added = true;
      return { status: 204, json: null };
    });
    const after = await run(replaced, []);
    assert.equal(after.code, 0, after.err.join('\n'));
    assert.ok(!byHand(after.out).some((line) => line.includes('FIGMA_LIBRARY')), after.out.join('\n'));
  });

  it('names each job that passes no FIGMA_LIBRARY, and takes `secrets: inherit` as passing it', () => {
    const both = workflow('main', '0.5.5', true);
    assert.deepEqual(jobsWithoutLibrary(both), []);
    const [head = '', weekly = ''] = both.split('  process-rules-weekly:');
    const prOnly = `${head.replace('      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n', '      OTHER: ${{ secrets.OTHER }}\n')}  process-rules-weekly:${weekly}`;
    assert.deepEqual(jobsWithoutLibrary(prOnly), ['process-rules']);
    assert.deepEqual(jobsWithoutLibrary(prOnly.replace(/ {4}secrets:\n(?: {6}.*\n)+/, '    secrets: inherit\n')), []);
    assert.deepEqual(jobsWithoutLibrary(workflow('main', '0.5.5', false)), ['process-rules', 'process-rules-weekly', 'process-rules-merged', 'process-rules-asks']);
  });

  it('prints no command for an older library value that is not a file key', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'x; rm -rf ~' } }));
    const { out } = await run(sys);
    assert.ok(byHand(out).includes("FIGMA_LIBRARY secret: the design library's file key → https://github.com/example-org/example-app/settings/secrets/actions"), out.join('\n'));
    assert.deepEqual(planned(out, 'GitHub'), []);
    assert.ok(!out.some((line) => line.includes('gh secret set')));
    assert.ok(!sys.requests.some((r) => r.url.includes('/actions/secrets')), 'nothing that is not a file key is stored as one');
  });

  it('writes the workflow and pre-push hook once work rules are on', async () => {
    const sys = fresh();
    await run(sys, ['example-owner', AGENT, '--features', 'work-rules']);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'work-rules']);
    assert.ok(repo(sys).has(WORKFLOW) && sys.files.has(PRE_PUSH));
  });

  it('adds nothing when the feature is already on', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'pr-identity'] }));
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), false));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    const before = repo(sys).get(SETTINGS);
    const { out } = await run(sys, ['--add', 'pr-identity']);
    assert.deepEqual(planned(out, 'Pull request'), []);
    assert.deepEqual(planned(out, 'Check'), ['one signed test commit by ExampleBot, deleted after']);
    assert.equal(repo(sys).get(SETTINGS), before);
  });

  for (const [name, args, change, message] of [
    ['--features for a repo that has settings', ['--features', 'board'], (sys: FakeSys) => sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT })), 'onboard: .github/process-rules.json already lists its features; turn one more on with --add <feature>'],
    ['--add with no settings', ['--add', 'board'], () => undefined, 'onboard: there is no .github/process-rules.json to add to; run process-rules onboard <owner> <agent> first'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      change(sys);
      const { code, err } = await run(sys, [...args]);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
    });
  }

  it('leaves the settings alone when a turned-on feature\'s setup stops', async () => {
    const sys = fresh();
    const before = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] });
    sys.files.set(SETTINGS, before);
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.route('POST', '/orgs/example-org/issue-types', { status: 422, json: null });
    await assert.rejects(run(sys, ['--add', 'board']), /GitHub did not add the issue type Work item \(HTTP 422\)/);
    assert.equal(repo(sys).get(SETTINGS), before);
    assert.equal(sys.spinning, 0, 'the spinner stops when a step throws');
  });

  it('changes nothing when turning a feature on is declined', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.answers = ['n'];
    const { code, err } = await run(sys, ['--add', 'board']);
    assert.deepEqual({ code, err }, { code: 1, err: [] });
    assert.ok(changedNothing(sys));
  });
});

describe('the plan and its one question', () => {
  it('goes ahead without asking with --yes, with no terminal too', async () => {
    const sys = fresh();
    sys.tty = false;
    sys.answers = [];
    const { code, out, err } = await run(sys, ['example-owner', AGENT, '--yes']);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.deepEqual(sys.chosen, [], 'no question');
    assert.ok(out.includes('◇  Go ahead? Yes (--yes)'));
    assert.ok(out.indexOf('◇  Go ahead? Yes (--yes)') > out.indexOf('◇  Check'), 'after the plan');
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
  });

  it("turns auto-merge on for its pull request as the agent, squashing, so it merges itself", async () => {
    const sys = fresh();
    const board = new Board(sys);
    sys.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_auto_merge: true, allow_squash_merge: false, allow_rebase_merge: true } });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes('auto-merge: when checks pass'));
    assert.deepEqual(board.autoMerge, { id: 'PR_7', method: 'REBASE' }, 'the first method the repository allows');
    const asked = sys.requests.find((r) => JSON.stringify(r.body ?? '').includes('enablePullRequestAutoMerge'));
    assert.equal(asked?.token, TOKEN, 'as the agent');
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.ok(!byHand(out).some((line) => line.startsWith('auto-merge')));
    const squash = fresh();
    const squashing = new Board(squash);
    await run(squash);
    assert.deepEqual(squashing.autoMerge, { id: 'PR_7', method: 'SQUASH' }, 'squash when GitHub does not say otherwise');
  });

  it("titles the pull request and its commit in the default branch's style: an emoji first when its subjects have one", async () => {
    const sys = fresh();
    const subjects = ['✨ feat(app): a (#9)', '🔥 chore(tooling): b (#8)', '🔧 chore(process-rules): onboard at v0.5.1 (#7)', 'Merge pull request #6 from example-org/x'];
    sys.route('GET', `${REPO}/commits?sha=main&per_page=20`, { status: 200, json: subjects.map((message) => ({ commit: { message: `${message}\n\nbody` } })) });
    const { code, err } = await run(sys);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    const title = `🔧 chore(process-rules): onboard at v${packageVersion()}`;
    assert.equal(opened(sys)?.title, title);
    const commit = sys.calls.find((c) => c.command === 'git' && c.args[0] === 'commit-tree' && c.cwd === '/tmp/process-rules-2');
    assert.deepEqual(commit?.args.slice(-2), ['-m', title], 'the commit header is the title');
    assert.equal(sys.requests.find((r) => r.url.includes('/commits?'))?.token, TOKEN, 'asked as the agent');
  });

  it('lets a Mergify merge queue merge it, without asking the owner to turn auto-merge on', async () => {
    const sys = fresh();
    const board = new Board(sys);
    sys.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_auto_merge: false } });
    const config = 'queue_rules:\n  - name: default\npull_request_rules:\n  - name: queue when green\n    conditions: [check-success=CI]\n    actions:\n      queue:\n';
    sys.route('GET', `${REPO}/contents/.mergify.yml?ref=main`, { status: 200, json: { content: Buffer.from(config).toString('base64') } });
    const { code, out, err } = await run(sys);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.ok(planned(out, 'Pull request').includes('merge queue: Mergify, when checks pass'), out.join('\n'));
    assert.ok(!planned(out, 'Pull request').some((item) => item.startsWith('auto-merge')));
    assert.equal(board.autoMerge, undefined, "GitHub's auto-merge is left to the queue");
    assert.ok(!sys.requests.some((r) => JSON.stringify(r.body ?? '').includes('enablePullRequestAutoMerge')));
    assert.ok(out.includes(`└  ${PULL_URL}  the merge queue merges it when checks pass`), out.join('\n'));
    assert.ok(!byHand(out).some((line) => line.startsWith('auto-merge')), byHand(out).join('\n'));
  });

  it('asks the owner to merge it when the repository does not allow auto-merge, or GitHub refuses it', async () => {
    const off = fresh();
    const board = new Board(off);
    off.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_auto_merge: false } });
    const { code, out, err } = await run(off);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.equal(board.autoMerge, undefined, 'not asked for');
    assert.ok(out.includes(`└  Merge ${PULL_URL}`));
    assert.equal(byHand(out)[0], 'auto-merge: turn on Allow auto-merge → https://github.com/example-org/example-app/settings, or merge it yourself');
    for (const [refusal, line] of [
      ['Pull request is in clean status', 'auto-merge: GitHub refused (Pull request is in clean status); merge it yourself'],
      ['Pull request Auto merge is not allowed for this repository', 'auto-merge: turn on Allow auto-merge → https://github.com/example-org/example-app/settings, or merge it yourself'],
    ]) {
      const sys = fresh();
      new Board(sys).autoMergeRefusal = refusal;
      const refused = await run(sys);
      assert.equal(refused.code, 0);
      assert.ok(refused.out.includes(`└  Merge ${PULL_URL}`));
      assert.equal(byHand(refused.out)[0], line);
    }
    const down = fresh();
    const http = down.http.bind(down);
    down.http = (url, options) =>
      JSON.stringify(options?.body ?? '').includes('enablePullRequestAutoMerge') ? Promise.reject(new Error('POST api.github.com/graphql could not be made: ECONNRESET')) : http(url, options);
    const cut = await run(down);
    assert.deepEqual({ code: cut.code, err: cut.err }, { code: 0, err: [] });
    assert.ok(cut.out.includes(`└  Merge ${PULL_URL}`));
    assert.equal(byHand(cut.out)[0], 'auto-merge: GitHub refused (POST api.github.com/graphql could not be made: ECONNRESET); merge it yourself');
    const none = fresh();
    none.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_squash_merge: false, allow_rebase_merge: false, allow_merge_commit: false } });
    assert.equal(byHand((await run(none)).out)[0], 'auto-merge: GitHub refused (example-org/example-app allows no merge method); merge it yourself');
  });

  it('prints the plan and changes nothing with --dry-run, with no terminal too', async () => {
    const sys = fresh();
    sys.tty = false;
    sys.answers = [];
    const { code, out, err } = await run(sys, ['example-owner', AGENT, '--dry-run']);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.deepEqual(sys.chosen, []);
    assert.equal(out[0], `◆  process-rules onboard   v${packageVersion()}`);
    assert.deepEqual(planned(out, 'Pull request'), [
      `process-rules.json: new, ${FEATURES.length} features on`,
      'settings.json: new',
      'workflow: new',
      `cloud-setup.sh: new, installs v${packageVersion()}`,
      'auto-merge: when checks pass',
    ]);
    assert.deepEqual(planned(out, 'Claude cloud — by hand, once'), ['Setup script: process-rules cloud-setup, first', `claude.ai's GitHub: as ${AGENT}`]);
    assert.equal(out.at(-1), '└  Dry run: nothing changed.');
    assert.ok(changedNothing(sys), 'nothing written, pushed or signed in to');
    assert.deepEqual(sys.committed.size, 0);
    assert.ok(!sys.opened.length, 'no browser');
  });

  it('signs in to nothing for a dry run, refusing one that would need the sign-in to choose the owner', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: ['example-owner', 'Second-Owner'], agent: AGENT }));
    const { code, err } = await run(sys, ['--dry-run']);
    assert.deepEqual({ code, err }, {
      code: 1,
      err: ['onboard: .github/process-rules.json names the owners example-owner or Second-Owner; name yours for a dry run, which signs in to nothing: process-rules onboard <owner> --dry-run'],
    });
    assert.equal(signIns(sys), 0);
    const first = fresh();
    first.files.set(`${first.home}/.config/process-rules/examplebot/session.sh`, sessionScript(AGENT, 42, pathsFor(first.home, AGENT)));
    first.answers = ['example-owner', ''];
    assert.equal((await run(first, ['--dry-run'])).code, 0);
    assert.equal(signIns(first), 0, 'no sign-in to suggest the owner');
    assert.equal(first.asked[0], 'The owner, who approves: ');
  });

  it('refuses in one line with no terminal and no --yes, asking nothing', async () => {
    const sys = fresh();
    sys.tty = false;
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['onboard: no terminal to ask in; pass --yes to go ahead without asking, or --dry-run to see the plan'] });
    assert.deepEqual([sys.chosen, sys.asked], [[], []]);
    const unnamed = fresh();
    unnamed.tty = false;
    assert.deepEqual((await run(unnamed, ['--yes'])).err, ['onboard: name the owner and the agent account: process-rules onboard <owner> <agent>']);
    assert.deepEqual(unnamed.asked, []);
  });

  it('keeps every item of the plan short', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', '0.5.2', true));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: OLDER_HOOK_COMMANDS[0] }] }] } }));
    sys.files.set(PRE_PUSH, OLDER_PRE_PUSH_HOOKS[0] as string);
    const { out } = await run(sys, ['example-owner', AGENT, '--dry-run']);
    const items = out.filter((line) => line.startsWith('│    '));
    assert.ok(items.length >= 6, out.join('\n'));
    for (const line of items) assert.ok(line.length <= 60, `${line.length} columns: ${line}`);
  });

  it('colours the plan only on a terminal with colours, and never with NO_COLOR', async () => {
    const coloured = fresh();
    coloured.env = { TERM: 'xterm-256color' };
    const { out } = await run(coloured, ['example-owner', AGENT, '--dry-run']);
    assert.equal(out[0], `\u001b[36m◆\u001b[0m  process-rules onboard   v${packageVersion()}`);
    assert.ok(out.includes('\u001b[32m◇\u001b[0m  Check'));
    for (const env of [{ TERM: 'xterm-256color', NO_COLOR: '1' }, { TERM: 'dumb' }]) {
      const plain = fresh();
      plain.env = env;
      assert.ok(!(await run(plain, ['example-owner', AGENT, '--dry-run'])).out.some((line) => line.includes('\u001b[')));
    }
    const piped = fresh();
    piped.tty = false;
    piped.env = { TERM: 'xterm-256color' };
    assert.ok(!(await run(piped, ['example-owner', AGENT, '--dry-run'])).out.some((line) => line.includes('\u001b[')));
  });

  it("shows gh's own errors from the sign-in, as gh wrote them", async () => {
    const sys = fresh();
    sys.ghToken = undefined;
    const { out } = await run(sys);
    assert.ok(out.includes('│  authentication cancelled'), out.join('\n'));
    assert.ok(out.includes('■  board'));
  });

  it('works out the workflow once the agent can push, when the default branch is not known before', async () => {
    const sys = fresh();
    let added = false;
    sys.route('GET', REPO, () => (added ? { status: 200, json: repoJson(true, 'trunk') } : { status: 404, json: null }));
    sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    sys.route('PUT', COLLABORATOR, () => {
      added = true;
      return { status: 204, json: null };
    });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes('workflow: new'), out.join('\n'));
    assert.match(repo(sys).get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
    // An existing workflow may change with the branch, which only GitHub can say: the plan says so.
    const existing = fresh();
    existing.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    existing.route('GET', REPO, { status: 404, json: null });
    existing.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    assert.ok(planned((await run(existing, ['example-owner', AGENT, '--dry-run'])).out, 'Pull request').includes('workflow: write or update'));
  });

  it("leaves a Project made before the template as it is, naming what is left to do by hand", async () => {
    const sys = fresh();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), items: [{ content: 'ISSUE_a', values: {} }] };
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(!board.operations.includes('copyProjectV2'), 'not replaced');
    assert.equal(board.project?.closed, undefined);
    assert.equal(byHand(out)[0], `group 2 views, auto-archive → ${URL}`);
    assert.ok(opened(sys)?.body.includes('  - Finish the Project'), 'the checklist is in the pull request');
  });
});

describe("onboard's pull request", () => {
  /** onboard's git step whose arguments start with `prefix`, in the temporary repository, failing. */
  const failing = (sys: FakeSys, prefix: string): void => {
    sys.execOverride = (call) =>
      call.cwd?.startsWith('/tmp/process-rules-') && call.args.join(' ').startsWith(prefix) ? { code: 1, stdout: '', stderr: 'boom\n' } : undefined;
  };

  for (const [step, said] of [
    ['init', 'onboard: git init failed: boom'],
    ['fetch', 'onboard: git fetch failed: boom'],
    ['hash-object -w', 'onboard: storing .github/process-rules.json failed: boom'],
    ['update-index', 'onboard: staging .github/process-rules.json failed: boom'],
    ['write-tree', 'onboard: git write-tree failed: boom'],
    ['commit-tree', 'onboard: signing the commit failed: boom'],
    ['push -q https://github.com/example-org/example-app.git +', 'onboard: pushing as ExampleBot failed: boom'],
  ] as const) {
    it(`deletes the temporary repository and opens nothing when ${step} fails`, async () => {
      const sys = fresh();
      failing(sys, step);
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [said, 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened'] });
      const temp = sys.calls.find((c) => c.args[0] === 'init' && c.cwd?.startsWith('/tmp/process-rules-'))?.cwd;
      assert.ok(temp && sys.removed.includes(temp), 'the temporary repository is deleted');
      assert.ok(!sys.requests.some((r) => r.method === 'POST' && r.url.endsWith('/pulls')));
    });
  }

  it('refuses a file the default branch has otherwise than this checkout, pushing nothing', async () => {
    const sys = fresh();
    sys.tip = new Map([['.github/process-rules.json', '{"owner":"someone-else"}\n']]);
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, ['onboard: .github/process-rules.json on main is not what this checkout has; bring this checkout up to date with main and run onboard again', 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened']);
    assert.ok(!sys.calls.some((c) => c.args.join(' ').includes('refs/heads/process-rules/onboard')));
    assert.ok(sys.removed.includes('/tmp/process-rules-2'));
  });

  it('updates the pull request a run before opened', async () => {
    const sys = fresh();
    sys.route('POST', `${REPO}/pulls`, { status: 422, json: { message: 'Validation Failed' } });
    sys.route('GET', `${REPO}/pulls?state=open&head=example-org:process-rules/onboard`, { status: 200, json: [{ number: 5, html_url: 'https://github.com/example-org/example-app/pull/5' }] });
    sys.route('PATCH', `${REPO}/pulls/5`, { status: 200, json: {} });
    const { code, out, err } = await run(sys);
    assert.deepEqual([code, err], [0, []]);
    const patched = sys.requests.find((r) => r.method === 'PATCH');
    assert.equal(patched?.token, TOKEN);
    assert.match((patched?.body as { body: string }).body, /Running onboard again updates this pull request\.$/);
    assert.equal((patched?.body as { title: string }).title, `chore(process-rules): onboard at v${packageVersion()}`, 'an older title is made conventional');
    assert.ok(out.includes('└  Merge https://github.com/example-org/example-app/pull/5'), 'no id from the open list: the owner merges it');
    assert.ok(byHand(out).includes('auto-merge: GitHub refused (GitHub gave no id for the pull request); merge it yourself'), out.join('\n'));
  });

  it('says so when the description of the open pull request cannot be updated, and goes on', async () => {
    const sys = fresh();
    sys.route('POST', `${REPO}/pulls`, { status: 422, json: { message: 'Validation Failed' } });
    sys.route('GET', `${REPO}/pulls?state=open&head=example-org:process-rules/onboard`, { status: 200, json: [{ number: 5, html_url: 'https://github.com/example-org/example-app/pull/5' }] });
    const { code, err } = await run(sys);
    assert.deepEqual([code, err], [0, ['onboard: could not update the description of https://github.com/example-org/example-app/pull/5 (HTTP 404)']]);
  });

  for (const [name, route, said] of [
    ['refuses it', { status: 403, json: { message: 'Resource not accessible' } }, 'onboard: GitHub did not open the pull request (HTTP 403: Resource not accessible); the changes are on process-rules/onboard'],
    ['finds no open one after a 422', { status: 422, json: null }, 'onboard: GitHub did not open the pull request (HTTP 422); the changes are on process-rules/onboard'],
  ] as const) {
    it(`fails when GitHub ${name}`, async () => {
      const sys = fresh();
      sys.route('POST', `${REPO}/pulls`, route);
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [said, 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened'] });
    });
  }

  it('commits each file once, with every change to it described', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'abc' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    new Board(sys);
    await actionsKey(sys);
    const { code } = await run(sys, ['--add', 'board']);
    assert.equal(code, 0);
    assert.deepEqual([...sys.committed.keys()], ['.github/process-rules.json']);
    const { body } = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith('/pulls'))?.body as { body: string };
    assert.match(body, /^- `\.github\/process-rules\.json`: take out "figma" .*; turn board on$/m);
    assert.equal(signIns(sys), 1, 'one sign-in, for the secret and the board');
    const login = sys.calls.find((call) => call.command === 'gh' && call.args[1] === 'login')?.args ?? [];
    assert.equal(login[login.indexOf('-s') + 1], 'project,admin:org', "the sign-in for the secret asks for the board's scopes too");
  });
});

describe('onboardArgs', () => {
  it('reads logins, --features and --add', () => {
    assert.deepEqual(onboardArgs(['a', 'b', '--features', 'board, work-rules']), { named: ['a', 'b'], features: ['identity', 'board', 'work-rules'] });
    assert.deepEqual(onboardArgs(['--add', 'review']), { named: [], add: 'review' });
    assert.deepEqual(onboardArgs(['a', '--yes', 'b', '--dry-run']), { named: ['a', 'b'], yes: true, dryRun: true });
  });

  for (const [args, message] of [
    [['--features'], /--features needs a value/],
    [['--add', 'board,review'], /--add takes one feature other than identity/],
    [['--add', 'identity'], /--add takes one feature other than identity/],
    [['--features', 'boards'], /unknown feature boards; the features are identity, pr-identity/],
    [['--force'], /unknown option --force/],
    [['a', 'b', 'c'], /unexpected argument "c"/],
  ] as const) {
    it(`refuses ${args.join(' ')}`, () => {
      assert.throws(() => onboardArgs([...args]), message);
    });
  }
});

describe('workflow', () => {
  it("calls the product's shared checks on pull requests and the default branch", () => {
    const text = workflow('main', '0.1.0', true);
    assert.match(text, /uses: athya-hq\/process-rules\/\.github\/workflows\/checks\.yml@v0\.1\.0\n {4}with:\n {6}process-rules-ref: v0\.1\.0\n/);
    assert.match(text, /branches: \["main"\]/);
    assert.match(text, /^# To upgrade, change the version on every line that names it \(two per job\)\.$/m);
    assert.deepEqual(workflowPins(text), Array(8).fill('0.1.0'));
  });

  it('keeps pull request and push runs read-only, and writes to issues on the weekly run and a merged pull request alone', () => {
    const text = workflow('main', '0.1.0', true);
    assert.match(text, /^permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read$/m);
    assert.match(text, /^ {4}types: \[opened, synchronize, reopened, edited, closed\]$/m);
    const [, prJob = '', weeklyJob = '', mergedJob = '', asksJob = ''] = text.split(/^ {2}(?:process-rules|process-rules-weekly|process-rules-merged|process-rules-asks):$/m);
    assert.match(prJob, /^ {4}if: \(github\.event_name == 'pull_request' && github\.event\.action != 'closed'\) \|\| github\.event_name == 'push'$/m);
    assert.doesNotMatch(prJob, /permissions:|: write/);
    assert.match(weeklyJob, /^ {4}if: \(github\.event_name == 'schedule' && github\.event\.schedule != '41 \* \* \* \*'\) \|\| github\.event_name == 'workflow_dispatch'$/m);
    assert.match(weeklyJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read$/m);
    assert.ok(
      asksJob.includes(
        "    if: >-\n      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&\n      (contains(github.event.comment.body, 'Needs you:') || contains(github.event.comment.body, 'Proposal:') ||\n      contains(github.event.comment.body, 'Decision:'))) ||\n      (github.event_name == 'issues' && github.event.label.name == 'approved') ||\n      (github.event_name == 'schedule' && github.event.schedule == '41 * * * *')\n",
      ),
      'only comments that may ask or decide, the approved label and the hourly sweep',
    );
    assert.match(asksJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: write$/m);
    assert.ok(text.includes("  issue_comment:\n    types: [created]\n  pull_request_review_comment:\n    types: [created]\n  issues:\n    types: [labeled]\n  # The weekly decisions job: Mondays, 06:17 UTC.\n  schedule:\n    - cron: '17 6 * * 1'\n    # Hourly: the owner's 👍 on an ask takes its needs-owner label off.\n    - cron: '41 * * * *'\n  workflow_dispatch:\n"));
    assert.ok(
      mergedJob.includes(
        "    if: >-\n      github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged &&\n      github.event.pull_request.base.ref == github.event.repository.default_branch &&\n      github.event.pull_request.head.repo.full_name == github.repository\n",
      ),
      'only a merge into the default branch from the repository itself',
    );
    assert.match(mergedJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read$/m);
    assert.equal(text.match(/issues: write/g)?.length, 3);
  });
});

const ASKS_WHAT = "add a job that labels an issue needs-owner where the agent asks the owner, and takes it off at the owner's approved label, Decision: comment or (hourly) 👍";

/** The three-job workflow releases before the needs-owner job wrote, from this release's. */
function threeJobs(version: string, figma: boolean, schedule?: string): string {
  return workflow('main', version, figma, schedule)
    .replace(/\n {2}# An ask labels its issue[\s\S]*$/, '\n')
    .replace('# The weekly, merged and needs-owner jobs are split out', '# The weekly and merged jobs are split out')
    .replace(/ {2}# A comment that asks the owner[^\n]*\n {2}issue_comment:\n {4}types: \[created\]\n {2}pull_request_review_comment:\n {4}types: \[created\]\n {2}issues:\n {4}types: \[labeled\]\n/, '')
    .replace(/ {4}# Hourly:[^\n]*\n {4}- cron: '41 \* \* \* \*'\n/, '')
    .replace("(github.event_name == 'schedule' && github.event.schedule != '41 * * * *') || github.event_name == 'workflow_dispatch'", "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
}

/** The two-job workflow releases before the merged job wrote, from this release's. */
function twoJobs(version: string, figma: boolean): string {
  return threeJobs(version, figma)
    .replace(/\n {2}# A merged pull request[\s\S]*$/, '')
    .replace('# The weekly and merged jobs are split out', '# The weekly job is split out')
    .replace('    # edited: a changed "Slice: #N" line is checked again; closed: a merged pull request closes its slice.\n    types: [opened, synchronize, reopened, edited, closed]', '    # edited: a changed "Slice: #N" line is checked again.\n    types: [opened, synchronize, reopened, edited]')
    .replace("(github.event_name == 'pull_request' && github.event.action != 'closed') || github.event_name == 'push'", "github.event_name == 'pull_request' || github.event_name == 'push'");
}

describe('workflowUpdate', () => {
  it('writes a missing workflow and leaves the same one alone', () => {
    assert.deepEqual(workflowUpdate(undefined, 'main', '0.5.3', true), { kind: 'write', text: workflow('main', '0.5.3', true) });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.3', true), 'main', '0.5.3', true), { kind: 'same' });
  });

  for (const from of ['0.4.0', '0.5.2', '0.5.3']) {
    it(`replaces the older single-job template at v${from}`, () => {
      const older = olderWorkflows('trunk', from)[0] as string;
      assert.match(older, /^ {6}issues: write$/m);
      assert.deepEqual(workflowUpdate(older, 'trunk', '0.5.3', true), { kind: 'replace-older', text: workflow('trunk', '0.5.3', true), from });
    });
  }

  it('moves the pins of a split workflow, quoted or not, and nothing else', () => {
    const before = workflow('main', '0.5.2', true)
      .replace("branches: [\"main\"]", "branches: ['main']")
      .replace('name: process-rules\n', 'name: process-rules\n# Our own note: split by hand at v0.5.2.\n')
      .replace('process-rules-ref: v0.5.2\n    secrets', "process-rules-ref: 'v0.5.2'\n    secrets");
    const update = workflowUpdate(before, 'main', '0.5.3', true);
    assert.equal(update.kind, 'repin');
    assert.ok(update.kind === 'repin');
    assert.equal(update.from, '0.5.2');
    assert.equal(update.text, before.replaceAll('0.5.2', '0.5.3').replace('split by hand at v0.5.3', 'split by hand at v0.5.2'));
    assert.match(update.text, /^# Our own note: split by hand at v0\.5\.2\.$/m);
    assert.deepEqual(workflowPins(update.text), Array(8).fill('0.5.3'));
  });

  it("sets each job's Figma secrets to what figma needs, leaving secrets of the client's own", () => {
    const older = workflow('main', '0.5.4', false).replaceAll(
      '      process-rules-ref: v0.5.4\n',
      '      process-rules-ref: v0.5.4\n    secrets:\n      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}\n',
    );
    assert.deepEqual(workflowUpdate(older, 'main', '0.5.5', true), { kind: 'repin', text: workflow('main', '0.5.5', true), from: '0.5.4', secrets: true });
    assert.deepEqual(workflowUpdate(older, 'main', '0.5.5', false), { kind: 'repin', text: workflow('main', '0.5.5', false), from: '0.5.4', secrets: true });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.5', true), 'main', '0.5.5', false), { kind: 'repin', text: workflow('main', '0.5.5', false), secrets: true });
    const own = older.replaceAll('FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}\n', 'FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}\n      OTHER: ${{ secrets.OTHER }}\n');
    const update = workflowUpdate(own, 'main', '0.5.5', false);
    assert.ok(update.kind === 'repin' && !update.secrets && update.text === own.replaceAll('0.5.4', '0.5.5'));
    const kept = workflowUpdate(own, 'main', '0.5.5', true);
    assert.ok(kept.kind === 'repin' && !kept.secrets && kept.text === own.replaceAll('0.5.4', '0.5.5'));
  });

  it('asks to pass, or stop passing, the Figma secrets', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    const off = await run(sys);
    assert.deepEqual(planned(off.out, 'Pull request'), ['workflow: no Figma secrets', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, stop passing Figma secrets, with figma off, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
    merge(sys);
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    sys.requests.length = 0;
    sys.answers = ['y'];
    const on = await run(sys);
    assert.deepEqual(planned(on.out, 'Pull request'), ['workflow: Figma secrets', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, pass the FIGMA_TOKEN and FIGMA_LIBRARY secrets, leaving the rest as it is\n`));
  });

  it('follows a changed default branch in a split workflow, keeping its quotes', () => {
    const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', "branches: ['main']");
    assert.deepEqual(workflowUpdate(before, 'trunk', '0.5.3', true), { kind: 'repin', text: before.replace("['main']", "['trunk']"), branch: 'trunk' });
    const update = workflowUpdate(workflow('main', '0.5.2', true), 'trunk', '0.5.3', true);
    assert.deepEqual(update, { kind: 'repin', text: workflow('trunk', '0.5.3', true), from: '0.5.2', branch: 'trunk' });
  });

  it('writes the schedule the settings set into the workflow', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, schedule: '0 9 * * 1-5' }));
    const { code } = await run(sys, []);
    assert.equal(code, 0);
    const text = repo(sys).get(WORKFLOW) ?? '';
    assert.equal(text, workflow('main', packageVersion(), true, '0 9 * * 1-5'));
    assert.ok(text.includes(`  # The decisions job: cron 0 9 * * 1-5, UTC, as "schedule" in .github/process-rules.json sets it.\n  schedule:\n    - cron: '0 9 * * 1-5'\n`));
    assert.ok(workflow('main', packageVersion(), true).includes("  # The weekly decisions job: Mondays, 06:17 UTC.\n  schedule:\n    - cron: '17 6 * * 1'\n"));
  });

  it('refuses a settings schedule that is not a cron before changing anything', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, schedule: 'Mondays' }));
    await assert.rejects(run(sys, []), /"schedule" must be a five-field cron/);
    assert.deepEqual(sys.asked, []);
    assert.ok(!repo(sys).has(WORKFLOW));
  });

  it('asks to move a split workflow to a changed schedule, leaving the rest as it is', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, schedule: '30 5 * * 2' }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    const own = workflow('main', packageVersion(), true).replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(planned(out, 'Pull request'), ['workflow: schedule → 30 5 * * 2', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, run the weekly decisions job on the schedule .github/process-rules.json sets, cron 30 5 * * 2 UTC, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true, '30 5 * * 2').replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n'));
  });

  it('follows a changed schedule in a split workflow, keeping its quotes and leaving a cron of its own', () => {
    const plain = workflow('main', '0.5.3', true);
    assert.deepEqual(workflowUpdate(plain, 'main', '0.5.3', true, '0 9 * * 1-5'), { kind: 'repin', text: workflow('main', '0.5.3', true, '0 9 * * 1-5'), schedule: '0 9 * * 1-5' });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.3', true, '0 9 * * 1-5'), 'main', '0.5.3', true), { kind: 'repin', text: plain, schedule: '17 6 * * 1' });
    const quoted = plain.replace("- cron: '17 6 * * 1'", '- cron: "17  6 * * 1"');
    assert.deepEqual(workflowUpdate(quoted, 'main', '0.5.3', true), { kind: 'same' });
    const moved = workflowUpdate(quoted, 'main', '0.5.3', true, '0 9 * * 1');
    assert.ok(moved.kind === 'repin' && moved.text.includes('    - cron: "0 9 * * 1"\n'));
    const bare = plain.replace("- cron: '17 6 * * 1'", '- cron: 17 6 * * 1');
    const unquoted = workflowUpdate(bare, 'main', '0.5.3', true, '0 9 * * 1');
    assert.ok(unquoted.kind === 'repin' && unquoted.text.includes("    - cron: '0 9 * * 1'\n"));
    const uncommented = plain.replace('  # The weekly decisions job: Mondays, 06:17 UTC.\n', '');
    const kept = workflowUpdate(uncommented, 'main', '0.5.3', true, '0 9 * * 1');
    assert.ok(kept.kind === 'repin' && kept.text === uncommented.replace("'17 6 * * 1'", "'0 9 * * 1'"));
    const two = plain.replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n    - cron: '0 12 * * 5'\n");
    assert.deepEqual(workflowUpdate(two, 'main', '0.5.3', true, '0 9 * * 1'), { kind: 'same' });
    const apart = plain.replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n\n    # Fridays too.\n    - cron: '0 12 * * 5'\n");
    assert.deepEqual(workflowUpdate(apart, 'main', '0.5.3', true, '0 9 * * 1'), { kind: 'same' });
    const noted = plain.replace("- cron: '17 6 * * 1'", "- cron: '17 6 * * 1' # ours");
    assert.deepEqual(workflowUpdate(noted, 'main', '0.5.3', true, '0 9 * * 1'), { kind: 'same' });
  });

  for (const [quote, written] of [
    ['"', '"it\'s \\"new\\""'],
    ["'", "'it''s \"new\"'"],
    ['', '"it\'s \\"new\\""'],
  ] as const) {
    it(`escapes a default branch with quotes in it, ${quote ? `in ${quote} quotes` : 'bare'}`, () => {
      const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', `branches: [${quote}main${quote}]`);
      const update = workflowUpdate(before, 'it\'s "new"', '0.5.3', true);
      assert.ok(update.kind === 'repin');
      assert.ok(update.text.includes(`\n    branches: [${written}]\n`));
    });
  }

  for (const branch of ['1.0', '2026', '2026-11-01', 'true', 'No', 'null', '0x1F']) {
    it(`quotes a bare default branch YAML would not read as a string, ${branch}`, () => {
      const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', 'branches: [main]');
      const update = workflowUpdate(before, branch, '0.5.3', true);
      assert.ok(update.kind === 'repin');
      assert.ok(update.text.includes(`\n    branches: ["${branch}"]\n`));
    });
  }

  it('leaves a bare branch bare', () => {
    const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', 'branches: [main]');
    const update = workflowUpdate(before, 'release/2.0', '0.5.3', true);
    assert.ok(update.kind === 'repin');
    assert.match(update.text, /^ {4}branches: \[release\/2\.0\]$/m);
  });

  it('leaves a push trigger listing several branches as it is', () => {
    const before = workflow('main', '0.5.2', true).replace('branches: ["main"]', 'branches: ["main", "release"]');
    const update = workflowUpdate(before, 'trunk', '0.5.3', true);
    assert.ok(update.kind === 'repin');
    assert.match(update.text, /branches: \["main", "release"\]/);
    assert.equal(update.branch, undefined);
  });

  it('asks to follow the default branch alone when the pins are current', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    sys.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('workflow: branch → trunk'), out.join('\n'));
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, run pushes on the default branch, trunk, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('trunk', packageVersion(), true));
  });

  it('replaces a workflow it does not recognise, a split one with a pin missing included', () => {
    assert.deepEqual(workflowUpdate('old', 'main', '0.5.3', true), { kind: 'replace', text: workflow('main', '0.5.3', true) });
    const halfPinned = workflow('main', '0.5.2', true).replace(/\n {4}with:\n {6}process-rules-ref: v0\.5\.2\n {4}secrets:/, '\n    secrets:');
    assert.equal(workflowPins(halfPinned).length, 7);
    assert.equal(workflowUpdate(halfPinned, 'main', '0.5.3', true).kind, 'replace');
    const changed = twoJobs('0.5.2', true).replace("github.event_name == 'pull_request' || github.event_name == 'push'", "github.event_name == 'push'");
    assert.equal(workflowUpdate(changed, 'main', '0.5.3', true).kind, 'replace');
  });

  it('adds the merged job to a two-job workflow, moving its pins and keeping what the client changed', () => {
    for (const figma of [true, false]) {
      assert.deepEqual(workflowUpdate(twoJobs('0.5.6', figma), 'main', '0.5.16', figma), { kind: 'repin', text: workflow('main', '0.5.16', figma), from: '0.5.6', merged: true, asks: true });
    }
    const own = twoJobs('0.5.6', true)
      .replace('# The weekly job is split out so pull request and push runs stay read-only.\n', '')
      .replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    const update = workflowUpdate(`${own}\n\n`, 'main', '0.5.16', true);
    assert.ok(update.kind === 'repin' && update.merged);
    assert.equal(update.text, `${workflow('main', '0.5.16', true).replace(/^# The weekly, merged and needs-owner jobs[^\n]*\n/m, '').replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n')}`);
  });

  it('asks to add the merged job', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    sys.files.set(WORKFLOW, twoJobs('0.5.6', false));
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'Pull request'), [`workflow: pins → v${packageVersion()}, merged job, needs-owner job`, 'auto-merge: when checks pass']);
    assert.equal(out[0], `◆  process-rules onboard   v0.5.6 → v${packageVersion()}`);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, move the version pins from v0.5.6 to v${packageVersion()} and add a job that closes the slice a merged pull request names, the one pull request run that writes to issues and ${ASKS_WHAT}, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
  });

  it('adds the needs-owner job to a three-job workflow, moving its pins and keeping what the client changed', () => {
    for (const figma of [true, false]) {
      assert.deepEqual(workflowUpdate(threeJobs('0.5.26', figma), 'main', '0.5.27', figma), { kind: 'repin', text: workflow('main', '0.5.27', figma), from: '0.5.26', asks: true });
    }
    assert.deepEqual(workflowUpdate(threeJobs('0.5.27', true), 'main', '0.5.27', true), { kind: 'repin', text: workflow('main', '0.5.27', true), asks: true });
    assert.deepEqual(workflowUpdate(threeJobs('0.5.26', true, '0 9 * * 1-5'), 'main', '0.5.27', true, '0 9 * * 1-5'), { kind: 'repin', text: workflow('main', '0.5.27', true, '0 9 * * 1-5'), from: '0.5.26', asks: true });
    const own = threeJobs('0.5.26', true).replace(/^# The weekly and merged jobs[^\n]*\n/m, '').replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    const update = workflowUpdate(own, 'main', '0.5.27', true);
    assert.ok(update.kind === 'repin' && update.asks);
    assert.equal(update.text, workflow('main', '0.5.27', true).replace(/^# The weekly, merged and needs-owner jobs[^\n]*\n/m, '').replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n'));
    assert.deepEqual(workflowPins(update.text), Array(8).fill('0.5.27'));
  });

  it('replaces a three-job workflow whose weekly job or schedule is its own', () => {
    const weekly = threeJobs('0.5.26', true).replace("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", "github.event_name == 'schedule'");
    assert.equal(workflowUpdate(weekly, 'main', '0.5.27', true).kind, 'replace');
    const crons = threeJobs('0.5.26', true).replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n    - cron: '0 12 * * 5'\n");
    assert.equal(workflowUpdate(crons, 'main', '0.5.27', true).kind, 'replace');
  });

  it('asks to add the needs-owner job', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    sys.files.set(WORKFLOW, threeJobs(packageVersion(), false));
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'Pull request'), ['workflow: needs-owner job', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, ${ASKS_WHAT}, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
  });

  it('replaces the older template written for a default branch since changed', () => {
    assert.deepEqual(workflowUpdate(olderWorkflows('main', '0.5.2')[0], 'trunk', '0.5.3', true), {
      kind: 'replace-older',
      text: workflow('trunk', '0.5.3', true),
      from: '0.5.2',
    });
  });
});

describe('onboard never moves the pin backwards', () => {
  const newer = '99.0.0';
  const encoded = (text: string) => ({ status: 200, json: { content: Buffer.from(text).toString('base64') } });

  it('refuses when the checkout already pins a newer release', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', newer, false));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), new RegExp(`pins process-rules v${newer}.*this is v${packageVersion()}`));
    assert.match(err.join('\n'), new RegExp(`pnpm add -g \\S+/v${newer}/athya-hq-process-rules-${newer}\\.tgz`), 'says how to update');
    assert.equal(opened(sys), undefined, 'opens no pull request');
    assert.equal(signIns(sys), 0, 'asks the owner for nothing');
  });

  it("refuses when the default branch on GitHub pins a newer release than a checkout that is behind", async () => {
    const sys = fresh();
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', newer, false)));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), new RegExp(`v${newer} \\(\\S+ on main\\)`));
    assert.equal(opened(sys), undefined);
  });

  const OPEN_PULLS = `${REPO}/pulls?state=open&head=example-org:process-rules/onboard`;

  it("refuses to overwrite an onboard pull request that a newer release opened", async () => {
    const sys = fresh();
    sys.route('GET', OPEN_PULLS, { status: 200, json: [{ number: 7 }] });
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=process-rules%2Fonboard`, encoded(workflow('main', newer, false)));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), new RegExp(`v${newer} \\(\\S+ on process-rules/onboard\\)`));
    assert.equal(opened(sys), undefined);
    assert.equal(sys.calls.some((call) => call.command === 'git' && call.args.includes('push')), false, 'pushes nothing');
  });

  it('leaves alone an onboard branch no open pull request uses', async () => {
    const sys = fresh();
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=process-rules%2Fonboard`, encoded(workflow('main', newer, false)));
    const { code } = await run(sys);
    assert.equal(code, 0, 'a closed pull request\'s branch is pushed over');
  });

  it('refuses when GitHub does not say what the repository pins', async () => {
    for (const [path, answer] of [
      [`${REPO}/contents/${WORKFLOW_PATH}?ref=main`, { status: 502, json: null }],
      [OPEN_PULLS, { status: 403, json: { message: 'Forbidden' } }],
    ] as const) {
      const sys = fresh();
      sys.route('GET', path, answer);
      const { code, err } = await run(sys);
      assert.equal(code, 1, path);
      assert.match(err.join('\n'), /HTTP (502|403).*run it again/, path);
      assert.equal(opened(sys), undefined, path);
    }
  });

  it('reads the default branch when the agent can only read the repository', async () => {
    const sys = fresh();
    sys.route('GET', REPO, { status: 200, json: { ...repoJson(), permissions: { push: false } } });
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', newer, false)));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /on main\)/);
  });

  it('refuses a newer checkout before asking the owner to sign in', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', newer, false));
    const { io, err } = capture();
    assert.equal(await onboard(sys, io, []), 1);
    assert.match(err.join('\n'), /never moves the pin back/);
    assert.equal(signIns(sys), 0);
  });

  it('refuses when the cloud setup file installs a newer release', async () => {
    const sys = fresh();
    sys.files.set(`${ROOT}/${CLOUD_SETUP_PATH}`, cloudRepoScript(newer, RELEASE_SHA256));
    const { code } = await run(sys);
    assert.equal(code, 1);
    assert.equal(opened(sys), undefined);
  });

  it('goes ahead when every pin is this release or older', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', '0.0.1', false)));
    const { code } = await run(sys);
    assert.equal(code, 0);
  });
});
