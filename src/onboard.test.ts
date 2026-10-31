import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Board, repoJson } from './fake-board.test.ts';
import { FIELDS, ISSUE_TYPES, LABELS, viewsChecklist } from './board.ts';
import { AGENT, FakeSys, ROOT, TOKEN, capture } from './fake.test.ts';
import { pathsFor, sessionScript } from './agent.ts';
import { FEATURES } from './features.ts';
import { packageVersion } from './version.ts';
import { HOOK_COMMAND, HOOKS_PATH, OLDER_HOOK_COMMANDS, PRE_PUSH_HOOK, WORKFLOW_PATH, onboard, onboardArgs, workflow } from './onboard.ts';

const SETTINGS = `${ROOT}/.github/process-rules.json`;
const HOOKS = `${ROOT}/${HOOKS_PATH}`;
const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
const PRE_PUSH = `${ROOT}/.git/hooks/pre-push`;
const REPO = '/repos/example-org/example-app';
const PUSH = { status: 200, json: repoJson() };
const VERIFIED = {
  status: 200,
  json: { committer: { login: AGENT }, commit: { verification: { verified: true, reason: 'valid' } } },
};

/** A Mac set up for the agent, a client repo with nothing in it yet, the agent able to push, yes to everything. */
function fresh(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.delete(SETTINGS);
  sys.route('GET', '/users/example-owner', { status: 200, json: { id: 1, login: 'example-owner' } });
  sys.route('GET', REPO, PUSH);
  sys.route('GET', `${REPO}/commits/abc123`, VERIFIED);
  new Board(sys);
  // Settings, hook, workflow; issue types, labels, Project, fields; test commit.
  sys.answers = Array<string>(11).fill('y');
  return sys;
}

async function run(sys: FakeSys, named: string[] = ['example-owner', AGENT]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await onboard(sys, io, named), out, err };
}

describe('onboard', () => {
  it('writes the files, finds the agent can push, and proves a Verified commit', async () => {
    const sys = fresh();
    const { code, out, err } = await run(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? ''), { owner: 'example-owner', agent: 'ExampleBot', features: [...FEATURES] });
    assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? ''), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] },
    });
    assert.equal(sys.files.get(WORKFLOW), workflow('main', packageVersion()));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
    assert.equal(sys.modes.get(PRE_PUSH), 0o755);
    assert.deepEqual(sys.dirs.filter((d) => d.startsWith(ROOT)), [`${ROOT}/.github`, `${ROOT}/.claude`, `${ROOT}/.github/workflows`]);
    assert.ok(out.includes('✓ ExampleBot can push to example-org/example-app'));
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
    assert.ok(out.includes('Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
    assert.equal(
      out.at(-1),
      'onboard: done. Commit .github/process-rules.json, .claude/settings.json and .github/workflows/process-rules.yml; agent sessions then work as ExampleBot.',
    );
    const git = sys.calls.filter((c) => c.command === 'git' && c.env);
    assert.deepEqual(git.map((c) => c.args.slice(0, 2).join(' ')), [
      'ls-remote https://github.com/example-org/example-app.git',
      'init -q',
      'fetch -q',
      'commit-tree -S',
      'push -q',
      'push -q',
    ]);
    assert.equal(git[0]?.env?.GH_TOKEN, TOKEN);
    assert.equal(git[0]?.env?.GIT_COMMITTER_EMAIL, '42+ExampleBot@users.noreply.github.com');
    assert.deepEqual(sys.calls.at(-1)?.args, ['-rf', '/tmp/verify']);
    const reads = sys.requests.filter((r) => r.url === `https://api.github.com${REPO}`);
    assert.equal(reads[0]?.token, TOKEN, 'checks access as the agent');
    assert.ok(out.includes('✓ fields: Step, Decision, Review date'));
    assert.ok(out.includes(viewsChecklist('https://github.com/orgs/example-org/projects/3')[0] ?? ''));
  });

  it("uses GitHub's spelling of logins typed in another case", async () => {
    const sys = fresh();
    sys.route('GET', '/users/EXAMPLE-OWNER', { status: 200, json: { id: 1, login: 'example-owner' } });
    assert.equal((await run(sys, ['EXAMPLE-OWNER', 'examplebot'])).code, 0);
    assert.match(sys.files.get(SETTINGS) ?? '', /"owner": "example-owner",\n {2}"agent": "ExampleBot"/);
  });

  it('reads the accounts from existing settings, and skips what is done', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
    sys.files.set(WORKFLOW, workflow('main', packageVersion()));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: FIELDS.map((f) => f.name), linked: true };
    const { code } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Push']);
  });

  it("replaces an older release's hook where it stands", async () => {
    const sys = fresh();
    const older = OLDER_HOOK_COMMANDS[0] as string;
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: older }] }] } }));
    await run(sys);
    assert.ok(sys.asked.some((q) => q.startsWith("Replace the older process-rules SessionStart hook in .claude/settings.json with this release's?")));
    assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? '').hooks.SessionStart, [
      { hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: HOOK_COMMAND }] },
    ]);
  });

  it("swaps only the older SessionStart command, keeping the file's layout", async () => {
    const sys = fresh();
    const older = JSON.stringify(OLDER_HOOK_COMMANDS[0]);
    const text = `{\r\n    "hooks": {\r\n        "Stop": [ { "hooks": [ { "command": ${older} } ] } ],\r\n        "SessionStart": [ { "hooks": [ { "command": ${older} } ] } ]\r\n    }\r\n}\r\n`;
    sys.files.set(HOOKS, text);
    await run(sys);
    const at = text.lastIndexOf(older);
    assert.equal(sys.files.get(HOOKS), `${text.slice(0, at)}${JSON.stringify(HOOK_COMMAND)}${text.slice(at + older.length)}`);
  });

  it('refuses a settings file it cannot add the hook to, before asking', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '{ "hooks": { "SessionStart": "x" } }');
    await assert.rejects(run(sys), /^Error: \.claude\/settings\.json: hooks\.SessionStart is not an array$/);
    assert.equal(sys.files.get(HOOKS), '{ "hooks": { "SessionStart": "x" } }');
    assert.ok(!sys.asked.some((q) => q.startsWith('Add the SessionStart hook')));
  });

  it("leaves a client's own hook that mentions session-start alone", async () => {
    const sys = fresh();
    const own = 'my-wrapper && process-rules session-start';
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: own }] }] } }));
    await run(sys);
    const commands = JSON.parse(sys.files.get(HOOKS) ?? '').hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    assert.deepEqual(commands, [own, HOOK_COMMAND]);
  });

  it("stops when replacing an older release's hook is declined", async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: OLDER_HOOK_COMMANDS[0] }] }, null, { hooks: 'x' }] } }));
    sys.answers = ['n'];
    assert.deepEqual((await run(sys, [])).err, ['onboard: stopped at "hook entry"; nothing after it was changed']);
  });

  it('runs nothing in a cloud session, says stop without the CLI, and runs session-start with it', () => {
    const bin = mkdtempSync(join(tmpdir(), 'process-rules-hook-'));
    writeFileSync(join(bin, 'process-rules'), '#!/bin/sh\necho "ran $*"\n', { mode: 0o755 });
    const broken = mkdtempSync(join(tmpdir(), 'process-rules-broken-'));
    writeFileSync(join(broken, 'process-rules'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
    const shell = (env: Record<string, string>) => spawnSync('bash', ['-c', HOOK_COMMAND], { encoding: 'utf8', env }).stdout;
    // With the CLI on PATH, a cloud session still runs nothing.
    assert.equal(shell({ PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: 'true' }), '');
    assert.match(shell({ PATH: '/usr/bin:/bin' }), /^process-rules: STOP\. The process-rules CLI is missing or did not run here/);
    assert.match(shell({ PATH: `${broken}:/usr/bin:/bin` }), /^process-rules: STOP\./);
    assert.equal(shell({ PATH: `${bin}:/usr/bin:/bin` }), 'ran session-start\n');
    rmSync(broken, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('adds the hook when the command only appears elsewhere', async () => {
    const sys = fresh();
    const lookalike = { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }], SessionStart: [{ hooks: [{ command: 'echo process-rules is set up elsewhere' }] }, {}] } };
    sys.files.set(HOOKS, JSON.stringify(lookalike));
    await run(sys);
    assert.ok(sys.asked.some((q) => q.startsWith('Add the SessionStart hook')));
    assert.equal(JSON.parse(sys.files.get(HOOKS) ?? '').hooks.SessionStart.length, 3);
  });

  it('uses GitHub\'s spelling of the accounts existing settings name', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'Example-Owner', agent: 'examplebot' }));
    sys.route('GET', '/users/Example-Owner', { status: 200, json: { id: 1, login: 'example-owner' } });
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.ok(out.includes(`✓ .github/process-rules.json: owner example-owner, agent ExampleBot; on: ${FEATURES.join(', ')}`));
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
  });

  it('refuses a repository with no commits, before pushing anything', async () => {
    const sys = fresh();
    sys.remoteHead = '';
    const { code, err } = await run(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ['onboard: example-org/example-app has no commits yet; push a first commit to it, then onboard again'] });
    assert.ok(!sys.calls.some((c) => c.args[0] === 'push'));
  });

  it('keeps the hooks a client already has', async () => {
    const sys = fresh();
    const own = { hooks: [{ type: 'command', command: 'echo hi' }] };
    sys.files.set(HOOKS, JSON.stringify({ env: { A: '1' }, hooks: { SessionStart: [own], Stop: [own] } }));
    await run(sys);
    assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? ''), {
      env: { A: '1' },
      hooks: { SessionStart: [own, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }], Stop: [own] },
    });
  });

  it("leaves the client's own pre-push hook, naming the line to add", async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, '#!/bin/sh\nnpm test\n');
    const { out } = await run(sys);
    assert.ok(out.includes('! .git/hooks/pre-push is your own; add this line to it: process-rules pre-push "$@"'));
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
    assert.ok(out.includes('! git runs hooks from /shared/hooks/pre-push, outside this repository; add this line to its pre-push hook: process-rules pre-push "$@"'));
    assert.ok(!sys.files.has('/shared/hooks/pre-push'));
  });

  it('counts only a hook line that runs the rules, not a mention', async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, '#!/bin/sh\n# TODO: process-rules pre-push\n');
    assert.ok((await run(sys)).out.some((line) => line.startsWith('! .git/hooks/pre-push is your own')));
    const ours = fresh();
    ours.files.set(PRE_PUSH, '#!/bin/sh\nnpm test\n  process-rules pre-push "$@"\n');
    assert.ok((await run(ours)).out.includes('✓ pre-push hook .git/hooks/pre-push'));
  });

  it('replaces a workflow that differs', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, 'old');
    sys.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    await run(sys);
    assert.ok(sys.asked.some((q) => q.startsWith('Replace .github/workflows/process-rules.yml')));
    assert.match(sys.files.get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
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
      'onboard: this Mac is not set up for ExampleBot; run process-rules machine ExampleBot, then onboard again',
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
    /** A Mac where machine set up the agent, with the owner signed in to gh. */
    function setUp(agents: string[]): FakeSys {
      const sys = fresh();
      for (const agent of agents) {
        sys.files.set(`${sys.home}/.config/process-rules/${agent.toLowerCase()}/session.sh`, sessionScript(agent, 42, pathsFor(sys.home, agent)));
      }
      sys.files.set(`${sys.home}/.config/process-rules/locked/gh/hosts.yml`, '');
      return sys;
    }

    it('takes the gh login as owner and the one agent set up here, with Enter', async () => {
      const sys = setUp([AGENT]);
      sys.answers = ['', '', ...Array<string>(11).fill('y')];
      const { code } = await run(sys, []);
      assert.equal(code, 0);
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
      assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? '').owner, 'example-owner');
    });

    it('lists the agents set up here and takes what is typed', async () => {
      const sys = setUp(['OtherBot', AGENT]);
      sys.answers = ['', 'examplebot', ...Array<string>(11).fill('y')];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.ok(out.includes('Accounts set up here for the agent: OtherBot, ExampleBot'));
      assert.equal(JSON.parse(sys.files.get(SETTINGS) ?? '').agent, AGENT);
    });

    it('suggests no owner when gh is signed out or GitHub will not answer', async () => {
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

  describe("keeping the client's settings layout", () => {
    it('adds only the hook entry to an existing file', async () => {
      const sys = fresh();
      const text = '{\n  "env": { "A": "1" },\n  "hooks": {\n    "Stop": [{ "hooks": [] }]\n  }\n}\n';
      sys.files.set(HOOKS, text);
      await run(sys);
      const out = sys.files.get(HOOKS) ?? '';
      assert.ok(out.startsWith('{\n  "env": { "A": "1" },\n  "hooks": {\n    "Stop": [{ "hooks": [] }],\n    "SessionStart": ['), out);
      assert.deepEqual(JSON.parse(out).hooks.SessionStart, [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }]);
    });

    it("swaps an older release's command in the text", async () => {
      const sys = fresh();
      const older = OLDER_HOOK_COMMANDS[0] as string;
      sys.files.set(HOOKS, `{ "env": { "A": "1" }, "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(older)} }] }] } }\n`);
      await run(sys);
      assert.equal(sys.files.get(HOOKS), `{ "env": { "A": "1" }, "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(HOOK_COMMAND)} }] }] } }\n`);
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
    it('gives an organisation member access through gh', async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
      sys.execOverride = (call) => {
        if (call.command !== 'gh' || call.args[0] !== 'api') return undefined;
        added = true;
        return { code: 0, stdout: '', stderr: '' };
      };
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(sys.calls.find((c) => c.command === 'gh')?.args, [
        'api', '-X', 'PUT', 'repos/example-org/example-app/collaborators/ExampleBot', '-f', 'permission=push',
      ]);
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
      sys.execOverride = (call) => {
        if (call.command !== 'gh' || call.args[0] !== 'api') return undefined;
        invited = true;
        return { code: 0, stdout: '', stderr: '' };
      };
      sys.answers = Array<string>(12).fill('y');
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.equal(sys.requests.find((r) => r.method === 'PATCH')?.token, TOKEN);
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
      assert.equal((await run(sys)).code, 0);
      assert.ok(!sys.calls.some((c) => c.command === 'gh' && c.args[0] === 'api'), 'invites no one');
    });

    for (const [name, setUp, message] of [
      [
        'gh failing to add the agent',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 500, json: null });
          sys.execOverride = (call) => (call.command === 'gh' ? { code: 1, stdout: '', stderr: 'HTTP 403\n' } : undefined);
        },
        ['onboard: gh could not add ExampleBot: HTTP 403', '  Add it yourself: example-org/example-app → Settings → Collaborators → Add people → ExampleBot, role Write.'],
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
          sys.execOverride = (call) => (call.command === 'gh' ? { code: 0, stdout: '', stderr: '' } : undefined);
        },
        ['onboard: ExampleBot still cannot see example-org/example-app; check the invitation reached ExampleBot'],
      ],
      [
        'read-only access',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 200, json: { ...repoJson(), permissions: { push: false } } }),
        ['onboard: ExampleBot can read example-org/example-app but not push; give it the Write role'],
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
        assert.deepEqual({ code, err }, { code: 1, err: [...message] });
      });
    }
  });

  describe('test commit', () => {
    it('deletes the branch even when GitHub cannot be asked', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, () => {
        throw new Error('down');
      });
      const { io, out } = capture();
      await assert.rejects(onboard(sys, io, ['example-owner', AGENT]), /down/);
      assert.ok(out.includes('Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
      assert.equal(sys.calls.at(-1)?.command, 'rm');
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
        assert.deepEqual({ code, err }, { code: 1, err: [message] });
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
        assert.ok(out.includes(`  ${shown}`), out.join('\n'));
        assert.deepEqual(err, ['onboard: GitHub does not show the commit Verified by ExampleBot']);
      });
    }
  });

  for (const [index, step] of [[0, 'settings file'], [1, 'hook entry'], [2, 'workflow'], [3, 'pre-push hook'], [8, 'test commit']] as const) {
    it(`stops without changing anything more when "${step}" is declined`, async () => {
      const sys = fresh();
      sys.answers = [...Array<string>(index).fill('y'), 'n'];
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`onboard: stopped at "${step}"; nothing after it was changed`] });
      assert.equal(sys.files.has(WORKFLOW), index > 2);
      assert.equal(sys.files.has(PRE_PUSH), index > 3);
    });
  }

  for (const [name, setUp, answers] of [
    ['inviting the agent', (sys: FakeSys) => {
      sys.route('GET', REPO, { status: 404, json: null });
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    }, ['y', 'y', 'n']],
    ['accepting the invitation', (sys: FakeSys) => {
      sys.route('GET', REPO, { status: 404, json: null });
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
    }, ['y', 'y', 'n']],
  ] as const) {
    it(`stops when ${name} is declined`, async () => {
      const sys = fresh();
      setUp(sys);
      sys.answers = [...answers];
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: stopped at "agent access"; nothing after it was changed'] });
    });
  }
});

describe('staged adoption', () => {
  it('sets up identity alone, with no workflow, hook or board', async () => {
    const sys = fresh();
    sys.answers = ['y', 'y', 'y'];
    const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? '').features, ['identity']);
    assert.ok(sys.files.has(HOOKS));
    assert.ok(!sys.files.has(WORKFLOW) && !sys.files.has(PRE_PUSH));
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql') || r.url.includes('/labels') || r.url.includes('/issue-types')), 'no board');
    assert.equal(out.at(-1), 'onboard: done. Commit .github/process-rules.json and .claude/settings.json; agent sessions then work as ExampleBot.');
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Write', 'Add', 'Push']);
  });

  it('turns one more feature on, keeping the other settings', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], project: 'Example work', figma: { library: 'L' } }));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
    const board = new Board(sys);
    sys.answers = ['y', 'y', 'y', 'y', 'y', 'y', 'y'];
    const { code } = await run(sys, ['--add', 'board']);
    assert.equal(code, 0);
    assert.deepEqual(board.titles, ['Example work']);
    assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? ''), {
      owner: 'example-owner',
      agent: AGENT,
      features: ['identity', 'board'],
      project: 'Example work',
      figma: { library: 'L' },
    });
    assert.ok(sys.asked.some((q) => q.startsWith('Create the Project "Example work"')));
    assert.ok(!sys.files.has(WORKFLOW), 'board alone needs no workflow');
  });

  it('writes the workflow and pre-push hook once work rules are on', async () => {
    const sys = fresh();
    sys.answers = Array<string>(5).fill('y');
    await run(sys, ['example-owner', AGENT, '--features', 'work-rules']);
    assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? '').features, ['identity', 'work-rules']);
    assert.ok(sys.files.has(WORKFLOW) && sys.files.has(PRE_PUSH));
  });

  it('adds nothing when the feature is already on', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'pr-identity'] }));
    sys.files.set(WORKFLOW, workflow('main', packageVersion()));
    const before = sys.files.get(SETTINGS);
    sys.answers = ['y'];
    await run(sys, ['--add', 'pr-identity']);
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Push']);
    assert.equal(sys.files.get(SETTINGS), before);
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
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
    sys.answers = ['y', 'n'];
    const { err } = await run(sys, ['--add', 'board']);
    assert.deepEqual(err, ['onboard: stopped at "issue types"; nothing after it was changed']);
    assert.equal(sys.files.get(SETTINGS), before);
  });

  it('stops when turning a feature on is declined', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.answers = ['n'];
    assert.deepEqual((await run(sys, ['--add', 'board'])).err, ['onboard: stopped at "settings file"; nothing after it was changed']);
  });
});

describe('onboardArgs', () => {
  it('reads logins, --features and --add', () => {
    assert.deepEqual(onboardArgs(['a', 'b', '--features', 'board, work-rules']), { named: ['a', 'b'], features: ['identity', 'board', 'work-rules'] });
    assert.deepEqual(onboardArgs(['--add', 'review']), { named: [], add: 'review' });
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
    const text = workflow('main', '0.1.0');
    assert.match(text, /uses: athya-hq\/process-rules\/\.github\/workflows\/checks\.yml@v0\.1\.0\n {4}with:\n {6}process-rules-ref: v0\.1\.0\n/);
    assert.match(text, /branches: \["main"\]/);
    assert.match(text, /^permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read$/m);
    assert.match(text, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read$/m);
  });
});
