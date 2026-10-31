import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, HOME, capture } from './fake.test.ts';
import { exposure, exposureLines, lockOwnerAway } from './lockout.ts';

const OWNER_KEY = `${HOME}/.ssh/id_ed25519`;

/** A Mac where the owner is signed in to gh, has a saved git password and an open SSH key. */
function exposed(): FakeSys {
  const sys = new FakeSys().ready();
  sys.ghAccounts = ['example-owner', AGENT, 'old-owner'];
  sys.gitPassword = true;
  sys.files.set(OWNER_KEY, 'open:key');
  sys.files.set(`${OWNER_KEY}.pub`, 'ssh-ed25519 OWNER');
  sys.files.set(`${HOME}/.ssh/id_rsa`, 'locked:key');
  sys.files.set(`${HOME}/.ssh/id_rsa.pub`, 'ssh-rsa OWNER');
  sys.files.set(`${HOME}/.ssh/config`, 'Host x');
  // Another agent set up on this Mac: its key has no passphrase on purpose.
  sys.files.set(`${HOME}/.config/process-rules/otherbot/session.sh`, '');
  sys.files.set(`${HOME}/.ssh/otherbot_signing`, 'open:agent');
  // An owner key with no .pub beside it, named like a signing key.
  sys.files.set(`${HOME}/.ssh/work_signing`, 'open:owner');
  return sys;
}

async function lock(sys: FakeSys, answers: string[]): Promise<string[]> {
  sys.answers = answers;
  const { io, out } = capture();
  await lockOwnerAway(sys, io, async (q) => /^y/.test(await sys.ask(q)), AGENT);
  return out;
}

describe('exposure', () => {
  it("finds the owner's gh accounts, saved git password and open keys, not the agents'", () => {
    const found = exposure(exposed(), AGENT);
    assert.deepEqual(found, { ghLogins: ['example-owner', 'old-owner'], gitPassword: true, openKeys: [OWNER_KEY, `${HOME}/.ssh/work_signing`], sshLogin: undefined });
    assert.deepEqual(exposureLines(found), [
      'gh is signed in as example-owner; an agent session that ignores the lock could use it',
      'gh is signed in as old-owner; an agent session that ignores the lock could use it',
      'the macOS keychain holds a saved git password for github.com; an agent session could use it',
      `${OWNER_KEY} has no passphrase; add one with: ssh-keygen -p -f ${OWNER_KEY}`,
      `${HOME}/.ssh/work_signing has no passphrase; add one with: ssh-keygen -p -f ${HOME}/.ssh/work_signing`,
    ]);
  });

  it("reads the owner's stored gh logins, not an agent session's", () => {
    const sys = exposed();
    sys.env = { GH_TOKEN: 'ghp_agent', GITHUB_TOKEN: 'x', GH_CONFIG_DIR: '/agent/gh', KEEP: '1' };
    exposure(sys, AGENT);
    const call = sys.calls.find((c) => c.command === 'gh');
    assert.deepEqual(call?.env, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: undefined, KEEP: '1' });
  });

  it("spares the signing key of an agent whose folder is empty", () => {
    const sys = new FakeSys().ready();
    sys.mkdir(`${HOME}/.config/process-rules/emptybot`);
    sys.files.set(`${HOME}/.ssh/emptybot_signing`, 'open:agent');
    assert.deepEqual(exposure(sys, AGENT).openKeys, []);
  });

  it('finds nothing on a clean Mac', () => {
    assert.deepEqual(exposureLines(exposure(new FakeSys().ready(), AGENT)), []);
  });
});

describe("the owner's SSH route", () => {
  /** A Mac whose SSH reaches GitHub as `login`, as `ssh -T git@github.com` says on stderr. */
  function greeted(login: string): FakeSys {
    const sys = new FakeSys().ready();
    sys.env = { GH_TOKEN: 'ghp_agent', KEEP: '1' };
    sys.execOverride = (call) =>
      call.command === 'ssh' ? { code: 1, stdout: '', stderr: `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.\n` } : undefined;
    return sys;
  }

  it('names the account SSH reaches GitHub as, and what covers it', () => {
    const sys = greeted('example-owner');
    const found = exposure(sys, AGENT);
    assert.equal(found.sshLogin, 'example-owner');
    assert.deepEqual(exposureLines(found), [
      "ssh reaches GitHub as example-owner with this Mac's keys; process-rules leaves your SSH access alone. Agent sessions send GitHub over HTTPS and refuse SSH, and the pre-push hook refuses their pushes over SSH",
    ]);
    const ssh = sys.calls.find((c) => c.command === 'ssh');
    assert.deepEqual(ssh?.args, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'git@github.com'], 'never asks for a passphrase');
    assert.equal(ssh?.env?.GH_TOKEN, undefined);
  });

  it("is no exposure when SSH reaches GitHub as the agent", () => {
    assert.equal(exposure(greeted('examplebot'), AGENT).sshLogin, undefined);
  });

  it('is named at the end of machine, which leaves it in place', async () => {
    const { io, out } = capture();
    await lockOwnerAway(greeted('example-owner'), io, () => Promise.resolve(true), AGENT);
    assert.deepEqual(out, [
      "! ssh reaches GitHub as example-owner with this Mac's keys; process-rules leaves your SSH access alone. Agent sessions send GitHub over HTTPS and refuse SSH, and the pre-push hook refuses their pushes over SSH",
    ]);
  });
});

describe('lockOwnerAway', () => {
  it('signs every owner account out of gh and removes the git password when told to', async () => {
    const sys = exposed();
    const out = await lock(sys, ['y', 'y', 'y']);
    assert.deepEqual(out.slice(0, 3), ['✓ gh signed out of example-owner', '✓ gh signed out of old-owner', '✓ removed the saved git password for github.com']);
    assert.deepEqual(sys.ghAccounts, [AGENT]);
    assert.equal(sys.gitPassword, false);
    assert.deepEqual(sys.calls.find((c) => c.args[1] === 'logout')?.args, ['auth', 'logout', '-h', 'github.com', '-u', 'example-owner']);
  });

  it('leaves them in place when declined', async () => {
    const sys = exposed();
    const out = await lock(sys, ['n', 'n', 'n']);
    assert.deepEqual(out.slice(0, 3), ['! gh stays signed in as example-owner', '! gh stays signed in as old-owner', '! the saved git password for github.com stays in the keychain']);
    assert.deepEqual(sys.ghAccounts, ['example-owner', AGENT, 'old-owner']);
    assert.equal(sys.gitPassword, true);
  });

  it('says so when removing fails', async () => {
    const sys = exposed();
    sys.execOverride = (call) => {
      if (call.command === 'gh' && call.args[1] === 'logout') return { code: 1, stdout: '', stderr: 'no such account\n' };
      if (call.command === 'git' && call.args[0] === 'credential-osxkeychain') return { code: 0, stdout: '', stderr: '' };
      return undefined;
    };
    const out = await lock(sys, ['y', 'n', 'y']);
    assert.deepEqual(out.slice(0, 3), ['! gh could not sign out of example-owner: no such account', '! gh stays signed in as old-owner', '! the saved git password for github.com is still in the keychain']);
  });

  it('says when there is nothing to lock away', async () => {
    assert.deepEqual(await lock(new FakeSys().ready(), []), ['✓ nothing of the owner here for an agent session to reach']);
  });
});
