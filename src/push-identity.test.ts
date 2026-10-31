import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { agentSession, pushIdentityProblem } from './push-identity.ts';
import { prePush } from './work.ts';

const HTTPS = 'https://github.com/example-org/example-app.git';
const LINES = `refs/heads/w ${'a'.repeat(40)} refs/heads/w ${'b'.repeat(40)}\n`;
const NOT_SET_UP = 'this session was not given the agent identity, which sends GitHub over HTTPS; tell the owner';

/** A shell whose git credential helpers hand out `password`, which GitHub knows as `login`. */
function withCredentials(password: string | undefined, login?: string): FakeSys {
  const sys = new FakeSys();
  sys.env = { CLAUDECODE: '1' };
  sys.execOverride = (call) =>
    call.args.join(' ') === 'credential fill'
      ? password
        ? { code: 0, stdout: `protocol=https\nhost=github.com\nusername=x\npassword=${password}\n`, stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: could not read Username: terminal prompts disabled' }
      : undefined;
  if (login) sys.acceptToken(password as string, login);
  return sys;
}

describe('agentSession', () => {
  it('is any shell Claude Code runs, or one session-start set up', () => {
    const sys = new FakeSys();
    assert.equal(agentSession(sys), false);
    sys.env = { CLAUDECODE: '1' };
    assert.equal(agentSession(sys), true);
    sys.env = { PROCESS_RULES_AGENT: AGENT };
    assert.equal(agentSession(sys), true);
    sys.env = { CLAUDECODE: '1', CLAUDE_CODE_REMOTE: 'true' };
    assert.equal(agentSession(sys), false, 'cloud sessions are left alone');
  });
});

describe('pushIdentityProblem', () => {
  for (const url of ['git@github.com:example-org/example-app.git', 'ssh://git@github.com/example-org/example-app.git', 'ssh://git@ssh.github.com:443/example-org/example-app.git']) {
    it(`refuses SSH to GitHub: ${url}`, async () => {
      assert.equal(
        await pushIdentityProblem(new FakeSys(), ROOT, url, AGENT),
        `this push goes to GitHub over SSH, with this Mac's SSH keys, which reach GitHub as their owner, not ${AGENT}: ${NOT_SET_UP}`,
      );
    });
  }

  it('lets a push through when git would push with the agent\'s token', async () => {
    const sys = withCredentials('ghp_agent', 'examplebot');
    assert.equal(await pushIdentityProblem(sys, ROOT, HTTPS, AGENT), undefined);
    const fill = sys.calls.find((c) => c.args[0] === 'credential');
    assert.deepEqual({ cwd: fill?.cwd, input: fill?.input, prompt: fill?.env?.GIT_TERMINAL_PROMPT, askpass: fill?.env?.GIT_ASKPASS }, {
      cwd: ROOT,
      input: 'protocol=https\nhost=github.com\n\n',
      prompt: '0',
      askpass: '',
    });
    assert.equal(sys.requests.at(-1)?.token, 'ghp_agent');
  });

  it("refuses a push with the owner's credentials, naming whose they are", async () => {
    assert.equal(
      await pushIdentityProblem(withCredentials('gho_owner', 'example-owner'), ROOT, HTTPS, AGENT),
      `this push would reach GitHub as example-owner, not ${AGENT}; agent sessions push only as ${AGENT}: ${NOT_SET_UP}`,
    );
  });

  it('passes the username a URL names to git', async () => {
    const sys = withCredentials('ghp_agent', AGENT);
    await pushIdentityProblem(sys, ROOT, 'https://ExampleBot@github.com/example-org/example-app.git', AGENT);
    assert.equal(sys.calls.find((c) => c.args[0] === 'credential')?.input, 'protocol=https\nhost=github.com\nusername=ExampleBot\n\n');
  });

  it('refuses when git has no credentials, or GitHub refuses them, or cannot be asked', async () => {
    assert.match((await pushIdentityProblem(withCredentials(undefined), ROOT, HTTPS, AGENT)) ?? '', /^git has no credentials for github\.com here/);
    assert.match((await pushIdentityProblem(withCredentials('process-rules-no-agent-token'), ROOT, HTTPS, AGENT)) ?? '', /^GitHub does not accept the credentials git would push with/);
    const down = withCredentials('ghp_agent');
    down.http = () => Promise.reject(new Error('offline'));
    assert.equal(await pushIdentityProblem(down, ROOT, HTTPS, AGENT), 'GitHub cannot be asked who this push is from (offline)');
    down.http = () => Promise.reject('offline');
    assert.equal(await pushIdentityProblem(down, ROOT, HTTPS, AGENT), 'GitHub cannot be asked who this push is from (offline)');
  });

  it('leaves remotes that are not GitHub alone', async () => {
    const sys = new FakeSys();
    assert.equal(await pushIdentityProblem(sys, ROOT, 'https://gitlab.com/a/b.git', AGENT), undefined);
    assert.equal(await pushIdentityProblem(sys, ROOT, '/srv/git/a.git', AGENT), undefined);
    assert.deepEqual(sys.calls, []);
  });
});

describe('prePush identity guard', () => {
  it("refuses an agent session's push with the owner's credentials before the work rules", async () => {
    const sys = withCredentials('gho_owner', 'example-owner');
    const { io, err } = capture();
    assert.equal(await prePush(sys, io, LINES, HTTPS), 1);
    assert.deepEqual(err, [
      `✗ this push would reach GitHub as example-owner, not ${AGENT}; agent sessions push only as ${AGENT}: ${NOT_SET_UP}`,
      `pre-push: refused; an agent session pushes to GitHub only as ${AGENT}`,
    ]);
    assert.ok(!sys.calls.some((c) => c.args[0] === 'log'), 'the work rules are not read');
  });

  it('refuses an SSH push from a session whose hooks never ran', async () => {
    const sys = new FakeSys();
    sys.env = { CLAUDECODE: '1' };
    const { io, err } = capture();
    assert.equal(await prePush(sys, io, LINES, 'git@github.com:example-org/example-app.git'), 1);
    assert.match(err[0] ?? '', /over SSH/);
  });

  it("leaves the owner's own pushes alone", async () => {
    const sys = new FakeSys();
    const { io, err } = capture();
    assert.equal(await prePush(sys, io, LINES, 'git@github.com:example-org/example-app.git'), 0);
    assert.deepEqual({ err, calls: sys.calls }, { err: [], calls: [] });
  });
});
