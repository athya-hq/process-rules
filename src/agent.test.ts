import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  NO_TOKEN,
  account,
  agentFrom,
  checkToken,
  keyBody,
  keyPairProblem,
  loadSettings,
  noreplyEmail,
  pathsFor,
  repoAt,
  sameLogin,
  sessionEnv,
  sessionScript,
  signingKeys,
  tokenInfo,
} from './agent.ts';
import { AGENT, AGENT_ID, CLASSIC, FakeSys, HOME, KEY, NOW, PRIVATE_KEY, PUBLIC_KEY, ROOT, TOKEN } from './fake.test.ts';

describe('loadSettings', () => {
  it('reads owner and agent', () => {
    assert.deepEqual(loadSettings(new FakeSys(), ROOT), { owner: 'example-owner', agent: AGENT });
  });

  it('says when the file is missing', () => {
    const sys = new FakeSys();
    sys.files.clear();
    assert.throws(() => loadSettings(sys, ROOT), /^Error: \.github\/process-rules\.json not found in \/repo$/);
  });

  for (const [raw, message] of [
    ['null', /"owner" must be a GitHub login/],
    ['{"owner":"a b","agent":"x"}', /"owner" must be a GitHub login/],
    ['{"owner":"me","agent":7}', /"agent" must be a GitHub login/],
    ['{"owner":"me","agent":"-bot"}', /"agent" must be a GitHub login/],
    ['{"owner":"me","agent":"me"}', /must be different accounts/],
    ['{"owner":"Me","agent":"mE"}', /must be different accounts/],
  ] as const) {
    it(`refuses ${raw}`, () => {
      const sys = new FakeSys();
      sys.files.set(`${ROOT}/.github/process-rules.json`, raw);
      assert.throws(() => loadSettings(sys, ROOT), message);
    });
  }
});

describe('agentFrom', () => {
  it('takes the login named after the command, in or out of a repo', () => {
    const sys = new FakeSys();
    sys.inRepo = false;
    assert.equal(agentFrom(sys, 'OtherBot'), 'OtherBot');
  });

  it('refuses a name that is not a login', () => {
    assert.throws(() => agentFrom(new FakeSys(), '-bot'), /"-bot" is not a GitHub login/);
  });

  it("falls back to the repo's settings", () => {
    assert.equal(agentFrom(new FakeSys(), undefined), AGENT);
  });

  for (const [where, change] of [
    ['outside a repo', (sys: FakeSys) => (sys.inRepo = false)],
    ['in a repo without settings', (sys: FakeSys) => sys.files.clear()],
  ] as const) {
    it(`asks for a name ${where}`, () => {
      const sys = new FakeSys();
      change(sys);
      assert.throws(() => agentFrom(sys, undefined), /name the agent account after the command, or run it in a repo/);
    });
  }
});

describe('repoAt', () => {
  for (const origin of [
    'https://github.com/example-org/example-app.git',
    'git@github.com:example-org/example-app.git',
    'https://github.com/example-org/example-app',
    'https://x-access-token@github.com/example-org/example-app.git',
    'ssh://git@github.com/example-org/example-app.git',
    'ssh://git@ssh.github.com:443/example-org/example-app.git',
  ]) {
    it(`reads the slug from ${origin}`, () => {
      const sys = new FakeSys();
      sys.origin = origin;
      assert.deepEqual(repoAt(sys), { root: ROOT, slug: 'example-org/example-app' });
    });
  }

  it('refuses outside a repository', () => {
    const sys = new FakeSys();
    sys.inRepo = false;
    assert.throws(() => repoAt(sys), /not inside a git repository/);
  });

  for (const origin of [
    'https://gitlab.com/a/b.git',
    'https://evilgithub.com/a/b.git',
    'https://github.com.evil.io/a/b.git',
    'git@evilgithub.com:a/b.git',
  ]) {
    it(`refuses the non-GitHub origin ${origin}`, () => {
      const sys = new FakeSys();
      sys.origin = origin;
      assert.throws(() => repoAt(sys), /origin is not a GitHub repository/);
    });
  }
});

describe('pathsFor and noreplyEmail', () => {
  it('keeps the key in ~/.ssh and the rest in a folder per agent account', () => {
    assert.deepEqual(pathsFor(HOME, AGENT), {
      key: `${HOME}/.ssh/examplebot_signing`,
      dir: `${HOME}/.config/process-rules/examplebot`,
      session: `${HOME}/.config/process-rules/examplebot/session.sh`,
      gh: `${HOME}/.config/process-rules/examplebot/gh`,
    });
    assert.equal(noreplyEmail(AGENT_ID, AGENT), '42+ExampleBot@users.noreply.github.com');
  });
});

describe('sessionScript, sourced by a real shell', () => {
  // An agent no keychain holds, so the script takes the no-token branch everywhere.
  const agent = 'NoSuchAgentZz9';
  const dir = mkdtempSync(join(tmpdir(), 'process-rules-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = pathsFor(dir, agent);
  const script = join(dir, 'session.sh');
  writeFileSync(script, sessionScript(agent, 7, paths));

  const shell = (command: string, env: Record<string, string> = {}): string => {
    const result = spawnSync('bash', ['-c', `. '${script}'; ${command}`], {
      encoding: 'utf8',
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, GITHUB_TOKEN: 'owner', ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  it('holds no token and refuses to fall back when the keychain has none', () => {
    assert.doesNotMatch(sessionScript(agent, 7, paths), /github_pat_|ghp_|gho_/);
    assert.equal(shell('printf %s "$GH_TOKEN|${GITHUB_TOKEN-unset}"'), `${NO_TOKEN}|unset`);
  });

  it('commits as the agent, signed with its key', () => {
    assert.equal(
      shell('git var GIT_COMMITTER_IDENT | cut -d" " -f1-2; git var GIT_AUTHOR_IDENT | cut -d" " -f1-2'),
      `${agent} <7+${agent}@users.noreply.github.com>\n`.repeat(2),
    );
    assert.equal(
      shell('git config gpg.format; git config user.signingkey; git config commit.gpgsign'),
      `ssh\n${paths.key}.pub\ntrue\n`,
    );
  });

  it('drops inherited git-config injection and askpass', () => {
    assert.equal(
      shell('printf %s "${GIT_CONFIG_PARAMETERS-unset}|${GIT_CONFIG-unset}|${GIT_ASKPASS-unset}|${SSH_ASKPASS-unset}"', {
        GIT_CONFIG_PARAMETERS: "'credential.helper'='!leak'",
        GIT_CONFIG: '/owner.gitconfig',
        GIT_ASKPASS: '/owner-askpass',
        SSH_ASKPASS: '/owner-askpass',
      }),
      'unset|unset|unset|unset',
    );
    const env = sessionEnv({ GIT_CONFIG_PARAMETERS: 'x', SSH_ASKPASS: 'y' }, 'a', 1, 't', paths);
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(env.SSH_ASKPASS, undefined);
  });

  it('gives git only the agent token, whatever helpers were set before', () => {
    // A global config whose helpers would hand out the owner's login.
    const global = join(dir, 'owner.gitconfig');
    const leak = '!f() { echo username=owner; echo password=leak; }; f';
    writeFileSync(
      global,
      `[credential]\n\thelper = "${leak}"\n[credential "https://github.com"]\n\thelper = "${leak}"\n`,
    );
    const out = shell(
      `export GH_TOKEN=tok; printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`,
      { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' },
    );
    assert.equal(out, `protocol=https\nhost=github.com\nusername=${agent}\npassword=tok\n`);
  });

  it('sends SSH GitHub remotes over HTTPS', () => {
    for (const remote of [
      'git@github.com:a/b.git',
      'ssh://git@github.com/a/b.git',
      'ssh://git@github.com:22/a/b.git',
      'ssh://git@ssh.github.com:443/a/b.git',
    ]) {
      assert.equal(shell(`git ls-remote --get-url ${remote}`), 'https://github.com/a/b.git\n', remote);
    }
  });

  it('turns SSH off for any remote left', () => {
    const result = spawnSync('bash', ['-c', `. '${script}'; git ls-remote ssh://git@example.invalid/a/b.git`], {
      encoding: 'utf8',
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SSH is off in agent sessions/);
  });

  it("keeps the agent token, and the owner's askpass, from other hosts", () => {
    // An askpass program the owner configured would otherwise answer git's prompt.
    const askpass = join(dir, 'owner-askpass.sh');
    writeFileSync(askpass, '#!/bin/sh\necho owner-secret\n', { mode: 0o755 });
    const global = join(dir, 'owner-askpass.gitconfig');
    writeFileSync(global, `[core]\n\taskpass = ${askpass}\n`);
    const out = shell(
      `export GH_TOKEN=tok; printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill 2>&1; echo "exit=$?"`,
      { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' },
    );
    assert.doesNotMatch(out, /password=tok|owner-secret/);
    assert.match(out, /exit=128/);
  });

  it('matches sessionEnv', () => {
    const env = sessionEnv({ GITHUB_TOKEN: 'owner', KEEP: '1' }, agent, 7, 'tok', paths);
    assert.equal(env.GH_TOKEN, 'tok');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.KEEP, '1');
    const names = Object.keys(env).filter((name) => /^(GIT_|GH_CONFIG|PROCESS_RULES)/.test(name) && env[name] !== undefined);
    for (const name of names) {
      assert.equal(shell(`printf %s "$${name}"`), env[name], name);
    }
  });
});

describe('GitHub reads', () => {
  it("finds an account's id and GitHub's spelling of its login, or says it is missing", async () => {
    assert.deepEqual(await account(new FakeSys(), 'examplebot'), { id: AGENT_ID, login: AGENT });
    await assert.rejects(account(new FakeSys(), 'Nobody'), /no account "Nobody" \(HTTP 404\)/);
  });

  it("reads a token's login, scopes and end", async () => {
    const sys = new FakeSys().acceptToken(TOKEN, AGENT);
    assert.deepEqual(await tokenInfo(sys, TOKEN), {
      login: AGENT,
      scopes: ['repo', 'workflow', 'read:org', 'project', 'write:ssh_signing_key'],
      expires: new Date('2027-01-28T12:00:00Z'),
    });
    assert.equal(await tokenInfo(sys, 'bad'), undefined);
  });

  it('reads a fine-grained or never-ending token as having no scopes or no end', async () => {
    const none = { login: AGENT, scopes: undefined, expires: undefined };
    const sys = new FakeSys().acceptToken(TOKEN, AGENT, {});
    assert.deepEqual(await tokenInfo(sys, TOKEN), none);
    sys.acceptToken('ghp_odd', AGENT, { 'github-authentication-token-expiration': 'soon' });
    assert.deepEqual(await tokenInfo(sys, 'ghp_odd'), none);
  });


  describe('checkToken', () => {
    const info = {
      login: AGENT,
      scopes: CLASSIC['x-oauth-scopes'].split(', '),
      expires: new Date('2027-01-28T12:00:00Z'),
    };
    const notClassic = 'it is not a classic token, which process-rules needs (see its docs/decisions.md)';
    for (const [name, token, given, problem] of [
      ['wider scopes that include the needed ones', TOKEN, { ...info, scopes: ['repo', 'workflow', 'admin:org', 'project', 'admin:ssh_signing_key'] }, undefined],
      ['a login differing only in case', TOKEN, { ...info, login: 'examplebot' }, undefined],
      ['a refused token', TOKEN, undefined, 'GitHub refuses the token (expired or revoked?)'],
      ["someone else's token", TOKEN, { ...info, login: 'example-owner' }, 'the token acts as example-owner, not ExampleBot'],
      ['a fine-grained token', 'github_pat_x', { ...info, scopes: undefined }, notClassic],
      ['a token GitHub reports no scopes for', TOKEN, { ...info, scopes: undefined }, notClassic],
      ['missing scopes', TOKEN, { ...info, scopes: ['repo', 'read:project'] }, 'the token lacks the scopes workflow, read:org, project, write:ssh_signing_key'],
      ['a token that never expires', TOKEN, { ...info, expires: undefined }, 'the token never expires; create one with an expiry (90 days recommended)'],
    ] as const) {
      it(`judges ${name}`, () => {
        assert.equal(checkToken(token, given, AGENT, NOW).problem, problem);
      });
    }

    it('counts whole days left on a good token', () => {
      assert.deepEqual(checkToken(TOKEN, info, AGENT, NOW), { problem: undefined, days: 90 });
      assert.deepEqual(checkToken(TOKEN, { ...info, expires: new Date('2026-10-31T11:00:00Z') }, AGENT, NOW), { problem: undefined, days: 0 });
    });
  });

  it('lists signing keys without comments', async () => {
    const sys = new FakeSys().route('GET', '/users/ExampleBot/ssh_signing_keys', {
      status: 200,
      json: [{ key: 'ssh-ed25519 AAAA x' }, { id: 1 }, null],
    });
    assert.deepEqual(await signingKeys(sys, AGENT), ['ssh-ed25519 AAAA']);
    await assert.rejects(signingKeys(new FakeSys(), 'Nobody'), /cannot list Nobody's signing keys \(HTTP 404\)/);
    const own = new FakeSys().route('GET', '/user/ssh_signing_keys', { status: 200, json: [{ key: 'ssh-ed25519 BBBB y' }] });
    assert.deepEqual(await signingKeys(own, AGENT, TOKEN), ['ssh-ed25519 BBBB']);
    assert.equal(own.requests.at(-1)?.token, TOKEN);
  });

  it('names what is wrong with a key pair', () => {
    const sys = new FakeSys();
    assert.equal(keyPairProblem(sys, KEY), `${KEY} is missing`);
    sys.files.set(KEY, 'garbage');
    assert.equal(keyPairProblem(sys, KEY), `${KEY} is not a usable private key`);
    sys.files.set(KEY, PRIVATE_KEY);
    assert.equal(keyPairProblem(sys, KEY), `${KEY}.pub is missing`);
    sys.files.set(`${KEY}.pub`, 'ssh-ed25519 other');
    assert.equal(keyPairProblem(sys, KEY), `${KEY}.pub does not match ${KEY}`);
    sys.files.set(`${KEY}.pub`, PUBLIC_KEY);
    assert.equal(keyPairProblem(sys, KEY), undefined);
  });

  it('compares logins ignoring case', () => {
    assert.equal(sameLogin('examplebot', AGENT), true);
    assert.equal(sameLogin('Other', AGENT), false);
    assert.equal(sameLogin(undefined, AGENT), false);
  });

  it('reduces a key line to type and body', () => {
    assert.equal(keyBody('  ssh-ed25519 AAAA comment here\n'), 'ssh-ed25519 AAAA');
  });
});
