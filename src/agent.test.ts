import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  NO_TOKEN,
  accountId,
  keyBody,
  keyPairProblem,
  loadSettings,
  noreplyEmail,
  pathsFor,
  readToken,
  repoAt,
  sameLogin,
  sessionEnv,
  sessionScript,
  signingKeys,
  storeToken,
  tokenLogin,
} from './agent.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, KEY, PRIVATE_KEY, PUBLIC_KEY, ROOT, TOKEN } from './fake.test.ts';

describe('loadSettings', () => {
  it('reads owner and agent', () => {
    assert.deepEqual(loadSettings(new FakeSys(), ROOT), { owner: 'AlokBansal8', agent: AGENT });
  });

  it('asks for setup when the file is missing', () => {
    const sys = new FakeSys();
    sys.files.clear();
    assert.throws(() => loadSettings(sys, ROOT), /not found in \/repo; run process-rules setup/);
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

describe('repoAt', () => {
  for (const origin of [
    'https://github.com/athya-hq/athya_mono.git',
    'git@github.com:athya-hq/athya_mono.git',
    'https://github.com/athya-hq/athya_mono',
    'https://x-access-token@github.com/athya-hq/athya_mono.git',
    'ssh://git@github.com/athya-hq/athya_mono.git',
    'ssh://git@ssh.github.com:443/athya-hq/athya_mono.git',
  ]) {
    it(`reads the slug from ${origin}`, () => {
      const sys = new FakeSys();
      sys.origin = origin;
      assert.deepEqual(repoAt(sys), { root: ROOT, slug: 'athya-hq/athya_mono' });
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
  it('keeps the key in ~/.ssh and the rest in ~/.config/process-rules', () => {
    assert.deepEqual(pathsFor(HOME, AGENT), {
      key: `${HOME}/.ssh/athyabot_signing`,
      dir: `${HOME}/.config/process-rules`,
      session: `${HOME}/.config/process-rules/session.sh`,
      gh: `${HOME}/.config/process-rules/gh`,
    });
    assert.equal(noreplyEmail(AGENT_ID, AGENT), '42+AthyaBot@users.noreply.github.com');
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

  it('keeps the agent token from other hosts', () => {
    const out = shell(
      `export GH_TOKEN=tok; printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill 2>&1; echo "exit=$?"`,
      { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    );
    assert.doesNotMatch(out, /password=tok/);
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

describe('keychain', () => {
  it('reads a stored token', () => {
    const sys = new FakeSys();
    sys.setToken(AGENT, TOKEN);
    sys.keychain.set('gh:github.com/Other', 'owners');
    assert.equal(readToken(sys, AGENT), TOKEN);
    assert.equal(readToken(sys, 'Other'), undefined);
  });

  it('stores a token through stdin, never argv', () => {
    const sys = new FakeSys();
    assert.equal(storeToken(sys, AGENT, TOKEN), true);
    assert.deepEqual([...sys.keychain], [['process-rules/AthyaBot', TOKEN]]);
    const call = sys.calls.find((c) => c.args[0] === '-i');
    assert.ok(call?.input?.includes(TOKEN));
    assert.ok(!call?.args.some((arg) => arg.includes(TOKEN)));
  });

  it('refuses a token with characters the keychain prompt could misread', () => {
    assert.equal(storeToken(new FakeSys(), AGENT, 'a b'), false);
  });

  it('reports a keychain that did not keep the token', () => {
    const sys = new FakeSys();
    sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 1, stdout: '', stderr: 'no' } : undefined);
    assert.equal(storeToken(sys, AGENT, TOKEN), false);
  });
});

describe('GitHub reads', () => {
  it('finds an account id, or says the account is missing', async () => {
    assert.equal(await accountId(new FakeSys(), AGENT), AGENT_ID);
    await assert.rejects(accountId(new FakeSys(), 'Nobody'), /no account "Nobody" \(HTTP 404\)/);
  });

  it('names the login a token acts as', async () => {
    const sys = new FakeSys().acceptToken(TOKEN, AGENT);
    assert.equal(await tokenLogin(sys, TOKEN), AGENT);
    assert.equal(await tokenLogin(sys, 'bad'), undefined);
  });

  it('lists signing keys without comments', async () => {
    const sys = new FakeSys().route('GET', '/users/AthyaBot/ssh_signing_keys', {
      status: 200,
      json: [{ key: 'ssh-ed25519 AAAA x' }, { id: 1 }, null],
    });
    assert.deepEqual(await signingKeys(sys, AGENT), ['ssh-ed25519 AAAA']);
    await assert.rejects(signingKeys(new FakeSys(), 'Nobody'), /cannot list Nobody's signing keys \(HTTP 404\)/);
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
    assert.equal(sameLogin('athyabot', AGENT), true);
    assert.equal(sameLogin('Other', AGENT), false);
    assert.equal(sameLogin(undefined, AGENT), false);
  });

  it('reduces a key line to type and body', () => {
    assert.equal(keyBody('  ssh-ed25519 AAAA comment here\n'), 'ssh-ed25519 AAAA');
  });
});
