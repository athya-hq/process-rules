import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BUILT_IN, Board, COPY_URL, repoJson, settledViews } from './fake-board.test.ts';
import { FIELDS, ISSUE_TYPES, LABELS } from './board.ts';
import { AGENT, FakeSys, ROOT, TOKEN, capture } from './fake.test.ts';
import type { HttpResult } from './types.ts';
import { pathsFor, sessionScript } from './agent.ts';
import { FEATURES } from './features.ts';
import { packageVersion } from './version.ts';
import { GUARD_COMMAND, HOOK_COMMAND, HOOKS_PATH, OLDER_HOOK_COMMANDS, OLDER_PRE_PUSH_HOOKS, PRE_PUSH_HOOK, WORKFLOW_PATH, claudeSettings, onboard, onboardArgs, workflow } from './onboard.ts';
import { BASE_ENV } from './agent.ts';

const SETTINGS = `${ROOT}/.github/process-rules.json`;
const HOOKS = `${ROOT}/${HOOKS_PATH}`;
const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
const PRE_PUSH = `${ROOT}/.git/hooks/pre-push`;
const REPO = '/repos/example-org/example-app';
const PUSH = { status: 200, json: repoJson() };
const SESSION_ENTRY = { hooks: [{ type: 'command', command: HOOK_COMMAND }] };
const GUARD_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_COMMAND }] };
/** The Claude Code settings this release writes into an empty project. */
const CLAUDE = { hooks: { SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV };
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
  // Settings, hook, workflow, pre-push hook; issue types, labels, Project; test commit; and spares.
  sys.answers = Array<string>(12).fill('y');
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
    assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? ''), CLAUDE);
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
    assert.ok(out.includes(`✓ Project "example-app work": ${COPY_URL}`));
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')), 'a copy of the template leaves nothing to do by hand');
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
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(WORKFLOW, workflow('main', packageVersion()));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    const { code } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Push']);
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
    assert.equal(sys.files.get(codeowners), '# Owners\n/app/ @example-org/core # app team\n');
    assert.ok(out.includes('✓ .github/CODEOWNERS: example-owner removed'));
    assert.equal(
      out.at(-1),
      'onboard: done. Commit .github/process-rules.json, .claude/settings.json, .github/workflows/process-rules.yml and .github/CODEOWNERS; agent sessions then work as ExampleBot.',
    );
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
      assert.equal(sys.files.get(codeowners), text);
      assert.ok(out.includes('! CODEOWNERS left as it is'));
      assert.equal(sys.asked.at(-1), 'Remove example-owner from that rule in CODEOWNERS? [y/N] ');
      assert.ok(!out.at(-1)?.includes('CODEOWNERS'));
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
            `set GH_TOKEN, GITHUB_TOKEN and ${Object.keys(BASE_ENV).length - 2} more in env, so GitHub is locked out until session-start gives the agent identity? [y/N] `,
        ),
        sys.asked.join('\n'),
      );
      assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? ''), {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: HOOK_COMMAND }] }], PreToolUse: [GUARD_ENTRY] },
        env: BASE_ENV,
      });
    });
  }

  it('sets only the lock variables that differ, keeping the client\'s own', () => {
    const { text, changes } = claudeSettings(JSON.stringify({ ...CLAUDE, env: { ...BASE_ENV, A: '1', GH_TOKEN: 'mine' } }));
    assert.deepEqual(JSON.parse(text).env, { ...BASE_ENV, A: '1' });
    assert.deepEqual(changes, ['set GH_TOKEN in env, so GitHub is locked out until session-start gives the agent identity']);
  });

  it('refuses an env that is not an object, and a file that is not one', () => {
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
    const written = sys.files.get(HOOKS) ?? '';
    assert.ok(written.startsWith(swapped.slice(0, swapped.lastIndexOf('\r\n    }'))), written);
    assert.ok(written.includes('\r\n        "PreToolUse": [\r\n            {\r\n                "matcher": "Bash",'), 'added in the file\'s own layout');
    assert.deepEqual(JSON.parse(written).env, BASE_ENV);
  });

  it('refuses a settings file it cannot add the hook to, before asking', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '{ "hooks": { "SessionStart": "x" } }');
    await assert.rejects(run(sys), /^Error: \.claude\/settings\.json: hooks\.SessionStart is not an array$/);
    assert.equal(sys.files.get(HOOKS), '{ "hooks": { "SessionStart": "x" } }');
    assert.ok(!sys.asked.some((q) => q.includes('.claude/settings.json')));
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

    it('session-start: nothing in a cloud session, its output, else STOP with why', () => {
      rmSync(launcher, { force: true });
      cli(join(bin, 'process-rules'), 'echo "ran $* with $(cat)"');
      assert.equal(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: 'true' }).stdout, '');
      const envFile = join(home, 'env.sh');
      shell(HOOK_COMMAND, { CLAUDE_CODE_REMOTE: 'true', CLAUDE_ENV_FILE: envFile, ...BASE_ENV });
      const cloud = spawnSync('bash', ['-c', `. ${envFile}; env`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...BASE_ENV } }).stdout;
      assert.ok(Object.keys(BASE_ENV).every((name) => !cloud.includes(`${name}=`)), `a cloud session loses the lock: ${cloud}`);
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
      assert.equal(hook({ CLAUDECODE: '1', CLAUDE_CODE_REMOTE: 'true' }).status, 0, 'cloud sessions are left alone');
      for (const env of [{ CLAUDECODE: '1' }, { PROCESS_RULES_AGENT: AGENT }]) {
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
      assert.equal(shell(GUARD_COMMAND, { CLAUDE_CODE_REMOTE: 'true' }, input('git push')).status, 0);
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
      env: { A: '1', ...BASE_ENV },
      hooks: { SessionStart: [own, SESSION_ENTRY], Stop: [own], PreToolUse: [GUARD_ENTRY] },
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
      sys.answers = ['', '', ...Array<string>(12).fill('y')];
      const { code } = await run(sys, []);
      assert.equal(code, 0);
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
      assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? '').owner, 'example-owner');
    });

    it('lists the agents set up here and takes what is typed', async () => {
      const sys = setUp(['OtherBot', AGENT]);
      sys.answers = ['', 'examplebot', ...Array<string>(12).fill('y')];
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
    it('adds only its entries to an existing file', async () => {
      const sys = fresh();
      const text = '{\n  "env": { "A": "1" },\n  "hooks": {\n    "Stop": [{ "hooks": [] }]\n  }\n}\n';
      sys.files.set(HOOKS, text);
      await run(sys);
      const out = sys.files.get(HOOKS) ?? '';
      assert.ok(out.startsWith('{\n  "env": { "A": "1",'), out);
      assert.ok(out.includes('\n  "hooks": {\n    "Stop": [{ "hooks": [] }],\n    "SessionStart": ['), out);
      assert.deepEqual(JSON.parse(out), { env: { A: '1', ...BASE_ENV }, hooks: { Stop: [{ hooks: [] }], SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] } });
    });

    it("swaps an older release's command in the text", async () => {
      const sys = fresh();
      const older = OLDER_HOOK_COMMANDS[0] as string;
      sys.files.set(HOOKS, `{ "env": { "A": "1" }, "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(older)} }] }] } }\n`);
      await run(sys);
      assert.ok((sys.files.get(HOOKS) ?? '').includes(`"SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(HOOK_COMMAND)} }] }]`));
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
      sys.execOverride = (call) => {
        if (call.command !== 'gh' || call.args[0] !== 'api') return undefined;
        assert.deepEqual(call.args, ['api', '-X', 'PUT', 'repos/example-org/example-app/collaborators/ExampleBot', '-f', 'permission=push']);
        invited = true;
        return { code: 0, stdout: '', stderr: '' };
      };
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
        'an agent still read-only',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 200, json: { ...repoJson(), permissions: { push: false } } });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
          sys.execOverride = (call) => (call.command === 'gh' ? { code: 0, stdout: '', stderr: '' } : undefined);
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
  it('sets up identity alone, with the pre-push hook but no workflow or board', async () => {
    const sys = fresh();
    sys.answers = ['y', 'y', 'y', 'y'];
    const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(sys.files.get(SETTINGS) ?? '').features, ['identity']);
    assert.ok(sys.files.has(HOOKS));
    assert.ok(!sys.files.has(WORKFLOW));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK, 'the identity guard, for every adopter');
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql') || r.url.includes('/labels') || r.url.includes('/issue-types')), 'no board');
    assert.equal(out.at(-1), 'onboard: done. Commit .github/process-rules.json and .claude/settings.json; agent sessions then work as ExampleBot.');
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Write', 'Write', 'Write', 'Push']);
  });

  it('turns one more feature on, keeping the other settings', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], project: 'Example work', figma: { library: 'L' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    const board = new Board(sys);
    sys.answers = Array<string>(8).fill('y');
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
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'pr-identity'] }));
    sys.files.set(WORKFLOW, workflow('main', packageVersion()));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
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
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
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
