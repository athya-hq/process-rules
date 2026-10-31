import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BUILT_IN, Board, COPY_URL, OWNER_TOKEN, repoJson, settledViews } from './fake-board.test.ts';
import { FIELDS, ISSUE_TYPES, LABELS } from './board.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, PULL_URL, ROOT, TOKEN, capture } from './fake.test.ts';
import type { HttpResult } from './types.ts';
import { pathsFor, sessionScript } from './agent.ts';
import { FEATURES } from './features.ts';
import { packageVersion } from './version.ts';
import { GUARD_COMMAND, HOOK_COMMAND, HOOKS_PATH, OLDER_HOOK_COMMANDS, OLDER_PRE_PUSH_HOOKS, PRE_PUSH_HOOK, REVIEW_THREAD_RULE, WORKFLOW_PATH, claudeSettings, jobsWithoutLibrary, olderWorkflows, onboard, onboardArgs, workflow, workflowPins, workflowUpdate } from './onboard.ts';
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
    assert.ok(out.includes('✓ ExampleBot can push to example-org/example-app'));
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
    assert.ok(out.includes('Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
    assert.deepEqual(out.slice(-3), [
      `✓ ExampleBot's pull request with .github/process-rules.json, .claude/settings.json, .github/workflows/process-rules.yml: ${PULL_URL}`,
      `onboard: done; nothing in this checkout was changed. Merge ${PULL_URL}; agent sessions then work as ExampleBot.`,
      "For Claude cloud sessions: connect claude.ai's GitHub as ExampleBot, and put what process-rules cloud-setup prints in the cloud environment's Setup script.",
    ]);
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
      ...['settings', 'hooks', 'workflow'].flatMap(() => ['rev-parse --verify', 'hash-object -w', 'update-index --add']),
      'write-tree --missing-ok',
      'commit-tree -S',
      'push -q',
    ]);
    assert.ok(git.every((c) => c.env?.GH_TOKEN === TOKEN && c.env.GIT_COMMITTER_EMAIL === '42+ExampleBot@users.noreply.github.com'), 'every git step as the agent');
    assert.ok(git.slice(6).every((c) => c.cwd === '/tmp/process-rules-2'), 'the pull request is made in a temporary repository');
    assert.deepEqual(git.at(-1)?.args, ['push', '-q', 'https://github.com/example-org/example-app.git', '+abc123:refs/heads/process-rules/onboard']);
    assert.ok(sys.removed.includes('/tmp/process-rules-2'), 'the temporary repository is deleted');
    assert.deepEqual([...sys.committed.keys()], ['.github/process-rules.json', '.claude/settings.json', '.github/workflows/process-rules.yml']);
    const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
    assert.equal(pull?.token, TOKEN, 'the agent opens the pull request');
    const { title, head, base, body } = pull?.body as { title: string; head: string; base: string; body: string };
    assert.deepEqual([title, head, base], [`process-rules onboard at v${packageVersion()}`, 'process-rules/onboard', 'main']);
    assert.match(body, /^- `\.github\/process-rules\.json`: owner example-owner approves, agent ExampleBot builds, with identity, .* on$/m);
    assert.match(body, /^- `\.github\/workflows\/process-rules\.yml`: write \.github\/workflows\/process-rules\.yml, which runs the shared process-rules checks$/m);
    assert.deepEqual(sys.calls.filter((c) => c.command === 'rm').at(-1)?.args, ['-rf', '/tmp/verify']);
    const reads = sys.requests.filter((r) => r.url === `https://api.github.com${REPO}`);
    assert.equal(reads[0]?.token, TOKEN, 'checks access as the agent');
    assert.ok(out.includes('✓ fields: Step, Decision, Review date'));
    assert.ok(out.includes(`✓ Project "example-app work": ${COPY_URL}`));
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')), 'a copy of the template leaves nothing to do by hand');
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
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Push']);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')), 'nothing to change, no pull request');
    assert.ok(!sys.calls.some((c) => c.args[0] === 'read-tree'));
    assert.equal(out.at(-2), "onboard: done; the repository's files need no change, so there is no pull request. Agent sessions work as ExampleBot.");
  });

  it("offers to remove the owner from CODEOWNERS, which would ask them to review every agent pull request", async () => {
    const sys = fresh();
    const codeowners = `${ROOT}/.github/CODEOWNERS`;
    sys.files.set(codeowners, '# Owners\n* @example-owner\n/app/ @example-org/core @EXAMPLE-OWNER # app team\n');
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(
      out.includes(
        '! .github/CODEOWNERS names example-owner in 2 rules (lines 2, 3): GitHub will ask example-owner to review every pull request ExampleBot opens that changes a file they match, ' +
          "because ExampleBot authors them and GitHub never asks a pull request's author",
      ),
      out.join('\n'),
    );
    assert.ok(sys.asked.includes('Remove example-owner from those rules in .github/CODEOWNERS, and drop the rule left with no owners, so its paths fall to the rules before? [y/N] '), sys.asked.join('\n'));
    assert.equal(repo(sys).get(codeowners), '# Owners\n/app/ @example-org/core # app team\n');
    assert.ok(out.includes('✓ .github/CODEOWNERS: example-owner removed'));
    assert.ok(
      out.includes(
        `✓ ExampleBot's pull request with .github/process-rules.json, .claude/settings.json, .github/workflows/process-rules.yml, .github/CODEOWNERS: ${PULL_URL}`,
      ),
      out.join('\n'),
    );
  });

  describe('with settings listing two owners and two agents', () => {
    const TEAM = { owner: ['example-owner', 'Second-Owner'], agent: ['OtherBot', AGENT], features: [...FEATURES] };
    const team = (): FakeSys => {
      const sys = fresh();
      sys.files.set(SETTINGS, `${JSON.stringify(TEAM, null, 2)}\n`);
      sys.files.set(pathsFor(HOME, AGENT).session, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
      return sys;
    };

    it('works as the first owner and the agent set up on this Mac, leaving the lists as they are', async () => {
      const sys = team();
      const codeowners = `${ROOT}/.github/CODEOWNERS`;
      sys.files.set(codeowners, '* @example-owner @second-owner\n/docs/ @Second-Owner @a\n');
      const { code, out, err } = await run(sys, []);
      assert.equal(code, 0, [...out, ...err].join('\n'));
      assert.ok(out.includes('✓ .github/process-rules.json: owner example-owner, agent ExampleBot; on: ' + FEATURES.join(', ')), out.join('\n'));
      assert.equal(repo(sys).get(SETTINGS), `${JSON.stringify(TEAM, null, 2)}\n`);
      assert.ok(sys.asked.includes('Remove example-owner and Second-Owner from those rules in .github/CODEOWNERS, and drop the rule left with no owners, so its paths fall to the rules before? [y/N] '), sys.asked.join('\n'));
      assert.equal(repo(sys).get(codeowners), '/docs/ @a\n');
      assert.ok(out.includes('✓ .github/CODEOWNERS: example-owner and Second-Owner removed'));
    });

    it('takes the owner and agent named, when the lists hold them', async () => {
      const sys = team();
      sys.route('GET', '/users/examplebot', { status: 200, json: { id: AGENT_ID, login: AGENT } });
      assert.equal((await run(sys, ['EXAMPLE-OWNER', 'examplebot'])).code, 0);
      assert.equal(repo(sys).get(SETTINGS), `${JSON.stringify(TEAM, null, 2)}\n`);
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

  it('leaves CODEOWNERS as it is without a yes, and goes on', async () => {
    for (const answer of ['', 'n']) {
      const sys = fresh();
      const codeowners = `${ROOT}/CODEOWNERS`;
      const text = '* @example-owner @a\n';
      sys.files.set(codeowners, text);
      // The CODEOWNERS question comes last, after the test commit.
      const before = fresh();
      await run(before);
      sys.answers = [...Array<string>(before.asked.length).fill('y'), answer];
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.ok(sys.asked.includes('Remove example-owner from that rule in CODEOWNERS? [y/N] '), sys.asked.join('\n'));
      assert.equal(repo(sys).get(codeowners), text);
      assert.ok(out.includes('! CODEOWNERS left as it is'));
      assert.equal(sys.asked.at(-1), 'Remove example-owner from that rule in CODEOWNERS? [y/N] ');
      assert.ok(!sys.committed.has('CODEOWNERS'));
      assert.ok(out.some((line) => line.startsWith("✓ ExampleBot's pull request") && !line.includes('CODEOWNERS')));
    }
  });

  it('asks nothing about a CODEOWNERS that does not name the owner', async () => {
    const sys = fresh();
    sys.files.set(`${ROOT}/.github/CODEOWNERS`, '* @example-org/core\n');
    await run(sys);
    assert.ok(!sys.asked.some((q) => q.includes('CODEOWNERS')));
  });

  for (const [release, older] of OLDER_HOOK_COMMANDS.entries()) {
    it(`upgrades an older release's hooks in place (${release})`, async () => {
      const sys = fresh();
      sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: older }] }] } }));
      await run(sys);
      assert.ok(
        sys.asked.includes(
          "Update .claude/settings.json: replace the older SessionStart hook that runs process-rules session-start with this release's; " +
            "add the PreToolUse hook that refuses gh and git's remote commands outside the agent identity; " +
            `set GH_TOKEN, GITHUB_TOKEN and ${Object.keys(BASE_ENV).length - 2} more in env, so GitHub is locked out until session-start gives the agent identity; ` +
            'allow process-rules review-thread without a prompt, so agent sessions answer review threads on their own pull requests? [y/N] ',
        ),
        sys.asked.join('\n'),
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
    assert.ok(!sys.asked.some((q) => q.includes('.claude/settings.json')));
  });

  it("leaves a client's own hook that mentions session-start alone", async () => {
    const sys = fresh();
    const own = 'my-wrapper && process-rules session-start';
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: own }] }] } }));
    await run(sys);
    const commands = JSON.parse(repo(sys).get(HOOKS) ?? '').hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    assert.deepEqual(commands, [own, HOOK_COMMAND]);
  });

  it("stops when replacing an older release's hook is declined", async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: OLDER_HOOK_COMMANDS[0] }] }, null, { hooks: 'x' }] } }));
    sys.answers = ['n'];
    assert.deepEqual((await run(sys, [])).err, ['onboard: stopped at "hook entry"; nothing after it was changed, and no pull request was opened']);
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
    await run(sys);
    assert.ok(sys.asked.some((q) => q.startsWith('Update .claude/settings.json: add the SessionStart hook')));
    assert.equal(JSON.parse(repo(sys).get(HOOKS) ?? '').hooks.SessionStart.length, 3);
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
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), {
      env: { A: '1', ...BASE_ENV },
      hooks: { SessionStart: [own, SESSION_ENTRY], Stop: [own], PreToolUse: [GUARD_ENTRY] },
      permissions: { allow: [REVIEW_THREAD_RULE] },
    });
  });

  it("replaces an older release's pre-push hook", async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, OLDER_PRE_PUSH_HOOKS[0] as string);
    await run(sys);
    assert.ok(sys.asked.includes('Replace the older process-rules pre-push git hook .git/hooks/pre-push, which checks an agent session pushes to GitHub as the agent, and the work rules? [y/N] '));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
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
    assert.match(repo(sys).get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
  });

  it("replaces an older release's single-job workflow, saying why", async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, olderWorkflows('main', '0.5.2')[0] as string);
    await run(sys);
    assert.ok(sys.asked.some((q) => q.startsWith('Replace the older .github/workflows/process-rules.yml, which lets every run write to issues')));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true));
  });

  it('moves only the version pins of a workflow already split', async () => {
    const sys = fresh();
    const own = workflow('main', '0.5.2', true).replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    await run(sys);
    assert.ok(sys.asked.some((q) => q === `In .github/workflows/process-rules.yml, move the version pins from v0.5.2 to v${packageVersion()}, leaving the rest as it is? [y/N] `));
    assert.equal(repo(sys).get(WORKFLOW), own.replaceAll('0.5.2', packageVersion()));
  });

  it('leaves a split workflow at this release alone', async () => {
    const sys = fresh();
    const own = workflow('main', packageVersion(), true).replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    await run(sys);
    assert.ok(!sys.asked.some((q) => q.includes(WORKFLOW_PATH)));
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
      sys.answers = ['', '', ...Array<string>(12).fill('y')];
      const { code } = await run(sys, []);
      assert.equal(code, 0);
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').owner, 'example-owner');
      assert.equal(signIns(sys), 1, 'the sign-in that suggested the owner serves the board too');
    });

    it('lists the agents set up here and takes what is typed', async () => {
      const sys = setUp(['OtherBot', AGENT]);
      sys.answers = ['', 'examplebot', ...Array<string>(12).fill('y')];
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
      assert.ok(out.includes('Sign in to GitHub as the owner in the browser, for this run only (repo, project, admin:org); nothing is kept.'));
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
        assert.deepEqual({ code, err }, { code: 1, err: [message] });
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
      assert.ok(out.includes(`! ${WHY}, so onboard leaves work-rules, figma, decisions off`));
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
        assert.deepEqual(sys.asked, []);
      });
    }

    it('refuses --add before renaming an older feature, changing nothing', async () => {
      const sys = personal();
      const settings = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] });
      sys.files.set(SETTINGS, settings);
      assert.equal((await run(sys, ['--add', 'work-rules'])).code, 1);
      assert.equal(repo(sys).get(SETTINGS), settings);
      assert.deepEqual(sys.asked, []);
    });

    it('names the features its settings list that cannot run there', async () => {
      const sys = personal();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'decisions'] }));
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.ok(out.includes(`! ${WHY}, so decisions cannot run here; their checks pass, saying so. Take them out of .github/process-rules.json's features`));
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
      sys.answers = Array<string>(13).fill('y');
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.equal(sys.requests.find((r) => r.method === 'PATCH')?.token, TOKEN);
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
      sys.answers = Array<string>(13).fill('y');
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.ok(invited, 'grants write access');
      assert.ok(sys.asked.some((q) => q.startsWith('ExampleBot can read but not push to example-org/example-app. Give it write access')));
      assert.ok(sys.asked.some((q) => q.startsWith("Accept ExampleBot's invitation")));
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
      assert.ok(!sys.requests.some((r) => r.method === 'PUT'), 'invites no one');
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
      const { code, out, err } = await run(sys);
      assert.equal(code, 1);
      assert.deepEqual(err, ['onboard: cannot ask GitHub whether the test commit is Verified (down); open the link above to see']);
      assert.ok(out.includes('Test commit https://github.com/example-org/example-app/commit/abc123'));
      assert.ok(out.includes('Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
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
      assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
      assert.deepEqual(sys.slept, [2000, 4000]);
    });

    it('names the last answer when GitHub keeps refusing', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, { status: 502, json: null });
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: cannot ask GitHub whether the test commit is Verified (HTTP 502); open the link above to see'] });
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

  for (const [index, step] of [[0, 'settings file'], [1, 'hook entry'], [2, 'workflow'], [3, 'pre-push hook'], [7, 'test commit']] as const) {
    it(`stops without changing anything more when "${step}" is declined`, async () => {
      const sys = fresh();
      sys.answers = [...Array<string>(index).fill('y'), 'n'];
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`onboard: stopped at "${step}"; nothing after it was changed, and no pull request was opened`] });
      assert.equal(sys.committed.size, 0, 'the files confirmed before the stop are not committed either');
      assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')));
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
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: stopped at "agent access"; nothing after it was changed, and no pull request was opened'] });
    });
  }
});

describe('staged adoption', () => {
  it('sets up identity alone, with the pre-push hook but no workflow or board', async () => {
    const sys = fresh();
    sys.answers = ['y', 'y', 'y', 'y'];
    const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity']);
    assert.ok(repo(sys).has(HOOKS));
    assert.ok(!repo(sys).has(WORKFLOW));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK, 'the identity guard, for every adopter');
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql') || r.url.includes('/labels') || r.url.includes('/issue-types')), 'no board');
    assert.equal(out.at(-3), `✓ ExampleBot's pull request with .github/process-rules.json, .claude/settings.json: ${PULL_URL}`);
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Write', 'Write', 'Write', 'Push']);
  });

  it('turns one more feature on, keeping the other settings', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], project: 'Example work', note: 'kept' }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    const board = new Board(sys);
    sys.answers = Array<string>(8).fill('y');
    const { code } = await run(sys, ['--add', 'board']);
    assert.equal(code, 0);
    assert.deepEqual(board.titles, ['Example work']);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), {
      owner: 'example-owner',
      agent: AGENT,
      features: ['identity', 'board'],
      project: 'Example work',
      note: 'kept',
    });
    assert.ok(sys.asked.some((q) => q.startsWith('Create the Project "Example work"')));
    assert.ok(!repo(sys).has(WORKFLOW), 'board alone needs no workflow');
  });

  it('renames design to figma, takes the library key out of older settings and sets it as the FIGMA_LIBRARY secret', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'], figma: { library: 'LibKey0123abc' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const pair = await actionsKey(sys);
    sys.answers = Array<string>(5).fill('y');
    const { code, out, err } = await run(sys);
    assert.deepEqual([code, err], [0, []]);
    assert.equal(
      sys.asked[0],
      'Update .github/process-rules.json: rename the design feature to figma and take out "figma" and set its library key as the FIGMA_LIBRARY Actions secret? [y/N] ',
    );
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] });
    const sent = sealedValue(sys, pair);
    assert.deepEqual([sent.value, sent.keyId, sent.token], ['LibKey0123abc', 'key-1', OWNER_TOKEN], "sealed with the repository's key, as the owner for this run");
    assert.equal(signIns(sys), 1);
    assert.ok(out.includes('✓ FIGMA_LIBRARY Actions secret: the library key taken out'));
    const said = [...out, ...err, ...sys.asked];
    assert.ok(!said.some((line) => line.includes('LibKey0123abc')), 'the key never appears in the output');
    assert.ok(!said.some((line) => /\bgh (secret|auth|api)\b/.test(line)), 'the owner is never told to run gh');
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true));
  });

  it('stops when the FIGMA_LIBRARY secret cannot be set, saying why without the key', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'LibKey0123abc' } }));
    await actionsKey(sys, { status: 403, json: { message: 'Must have admin rights to Repository.' } });
    sys.answers = ['y'];
    const { code, out, err } = await run(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, ['onboard: GitHub did not set the FIGMA_LIBRARY secret (HTTP 403: Must have admin rights to Repository.)']);
    assert.ok(![...out, ...err].some((line) => line.includes('LibKey0123abc')));
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')));
  });

  it('stops when the owner does not sign in to set the FIGMA_LIBRARY secret', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'LibKey0123abc' } }));
    sys.ghToken = undefined;
    sys.answers = ['y'];
    const { code, err } = await run(sys);
    assert.deepEqual([code, err], [1, ['onboard: the GitHub sign-in in the browser did not finish']]);
    assert.ok(!sys.requests.some((r) => r.method === 'PUT'));
  });

  it('renames design alone, and stops at a no', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] }));
    sys.answers = ['n'];
    const { code } = await run(sys);
    assert.equal(code, 1);
    assert.equal(sys.asked[0], 'Update .github/process-rules.json: rename the design feature to figma? [y/N] ');
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'design']);
  });

  it('takes out a library key from settings that list no features', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, figma: {} }));
    sys.answers = Array<string>(8).fill('y');
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
    sys.answers = ['y'];
    const { out } = await run(sys);
    assert.equal(repo(sys).get(WORKFLOW), own);
    assert.ok(out.includes("! In .github/workflows/process-rules.yml, process-rules and process-rules-weekly pass the shared checks no FIGMA_LIBRARY secret, so the design check stays off there; add FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }} under their secrets"));
  });

  it('names each job that passes no FIGMA_LIBRARY, and takes `secrets: inherit` as passing it', () => {
    const both = workflow('main', '0.5.5', true);
    assert.deepEqual(jobsWithoutLibrary(both), []);
    const [head = '', weekly = ''] = both.split('  process-rules-weekly:');
    const prOnly = `${head.replace('      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n', '      OTHER: ${{ secrets.OTHER }}\n')}  process-rules-weekly:${weekly}`;
    assert.deepEqual(jobsWithoutLibrary(prOnly), ['process-rules']);
    assert.deepEqual(jobsWithoutLibrary(prOnly.replace(/ {4}secrets:\n(?: {6}.*\n)+/, '    secrets: inherit\n')), []);
    assert.deepEqual(jobsWithoutLibrary(workflow('main', '0.5.5', false)), ['process-rules', 'process-rules-weekly']);
  });

  it('prints no command for an older library value that is not a file key', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'x; rm -rf ~' } }));
    sys.answers = ['y'];
    const { out } = await run(sys);
    assert.ok(
      out.includes(
        '! the "figma.library" taken out was not a Figma file key; set the FIGMA_LIBRARY Actions secret to the design library\'s file key under example-org/example-app → Settings → Secrets and variables → Actions',
      ),
    );
    assert.ok(!out.some((line) => line.includes('gh secret set')));
    assert.ok(!sys.requests.some((r) => r.url.includes('/actions/secrets')), 'nothing that is not a file key is stored as one');
  });

  it('writes the workflow and pre-push hook once work rules are on', async () => {
    const sys = fresh();
    sys.answers = Array<string>(5).fill('y');
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
    const before = repo(sys).get(SETTINGS);
    sys.answers = ['y'];
    await run(sys, ['--add', 'pr-identity']);
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Push']);
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
    sys.answers = ['y', 'n'];
    const { err } = await run(sys, ['--add', 'board']);
    assert.deepEqual(err, ['onboard: stopped at "issue types"; nothing after it was changed, and no pull request was opened']);
    assert.equal(repo(sys).get(SETTINGS), before);
  });

  it('stops when turning a feature on is declined', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.answers = ['n'];
    assert.deepEqual((await run(sys, ['--add', 'board'])).err, ['onboard: stopped at "settings file"; nothing after it was changed, and no pull request was opened']);
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
      assert.deepEqual({ code, err }, { code: 1, err: [said] });
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
    assert.deepEqual(err, ['onboard: .github/process-rules.json on main is not what this checkout has; bring this checkout up to date with main and run onboard again']);
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
    assert.ok(out.includes('onboard: done; nothing in this checkout was changed. Merge https://github.com/example-org/example-app/pull/5; agent sessions then work as ExampleBot.'));
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
      assert.deepEqual({ code, err }, { code: 1, err: [said] });
    });
  }

  it('commits each file once, with every change to it described', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'abc' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
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
    assert.deepEqual(workflowPins(text), ['0.1.0', '0.1.0', '0.1.0', '0.1.0']);
  });

  it('keeps pull request and push runs read-only and writes to issues on the weekly run alone', () => {
    const text = workflow('main', '0.1.0', true);
    assert.match(text, /^permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read$/m);
    const [, prJob = '', weeklyJob = ''] = text.split(/^ {2}(?:process-rules|process-rules-weekly):$/m);
    assert.match(prJob, /^ {4}if: github\.event_name == 'pull_request' \|\| github\.event_name == 'push'$/m);
    assert.doesNotMatch(prJob, /permissions:|: write/);
    assert.match(weeklyJob, /^ {4}if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'$/m);
    assert.match(weeklyJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read$/m);
    assert.equal(text.match(/issues: write/g)?.length, 1);
  });
});

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
    assert.deepEqual(workflowPins(update.text), ['0.5.3', '0.5.3', '0.5.3', '0.5.3']);
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
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    sys.answers = ['y', 'y'];
    await run(sys);
    assert.equal(sys.asked[0], `In ${WORKFLOW_PATH}, stop passing Figma secrets, with figma off, leaving the rest as it is? [y/N] `);
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
    merge(sys);
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    sys.asked.length = 0;
    sys.answers = ['y', 'y'];
    await run(sys);
    assert.equal(sys.asked[0], `In ${WORKFLOW_PATH}, pass the FIGMA_TOKEN and FIGMA_LIBRARY secrets, leaving the rest as it is? [y/N] `);
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
    const own = workflow('main', packageVersion(), true).replace('name: process-rules\n', 'name: process-rules\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { code } = await run(sys, []);
    assert.equal(code, 0);
    assert.equal(
      sys.asked[0],
      `In ${WORKFLOW_PATH}, run the weekly decisions job on the schedule .github/process-rules.json sets, cron 30 5 * * 2 UTC, leaving the rest as it is? [y/N] `,
    );
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
    await run(sys);
    assert.ok(sys.asked.includes('In .github/workflows/process-rules.yml, run pushes on the default branch, trunk, leaving the rest as it is? [y/N] '));
    assert.equal(repo(sys).get(WORKFLOW), workflow('trunk', packageVersion(), true));
  });

  it('replaces a workflow it does not recognise, a split one with a pin missing included', () => {
    assert.deepEqual(workflowUpdate('old', 'main', '0.5.3', true), { kind: 'replace', text: workflow('main', '0.5.3', true) });
    const halfPinned = workflow('main', '0.5.2', true).replace(/\n {4}with:\n {6}process-rules-ref: v0\.5\.2\n {4}secrets:/, '\n    secrets:');
    assert.equal(workflowPins(halfPinned).length, 3);
    assert.equal(workflowUpdate(halfPinned, 'main', '0.5.3', true).kind, 'replace');
  });

  it('replaces the older template written for a default branch since changed', () => {
    assert.deepEqual(workflowUpdate(olderWorkflows('main', '0.5.2')[0], 'trunk', '0.5.3', true), {
      kind: 'replace-older',
      text: workflow('trunk', '0.5.3', true),
      from: '0.5.2',
    });
  });
});
