import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, HOME, capture } from './fake.test.ts';
import { exposure, exposureLines, lockOwnerAway } from './lockout.ts';

const OWNER_KEY = `${HOME}/.ssh/id_ed25519`;

/** A Mac where the owner is signed in to gh, has a saved git password and an open SSH key. */
function exposed(): FakeSys {
  const sys = new FakeSys().ready();
  sys.ghToken = 'gho_owner';
  sys.acceptToken('gho_owner', 'example-owner');
  sys.gitPassword = true;
  sys.files.set(OWNER_KEY, 'open:key');
  sys.files.set(`${OWNER_KEY}.pub`, 'ssh-ed25519 OWNER');
  sys.files.set(`${HOME}/.ssh/id_rsa`, 'locked:key');
  sys.files.set(`${HOME}/.ssh/id_rsa.pub`, 'ssh-rsa OWNER');
  sys.files.set(`${HOME}/.ssh/config`, 'Host x');
  return sys;
}

async function lock(sys: FakeSys, answers: string[]): Promise<string[]> {
  sys.answers = answers;
  const { io, out } = capture();
  await lockOwnerAway(sys, io, async (q) => /^y/.test(await sys.ask(q)), AGENT);
  return out;
}

describe('exposure', () => {
  it("finds the owner's gh login, saved git password and open keys, not the agent's", async () => {
    const found = await exposure(exposed(), AGENT);
    assert.deepEqual(found, { ghLogin: 'example-owner', gitPassword: true, openKeys: [OWNER_KEY] });
    assert.deepEqual(exposureLines(found), [
      'gh is signed in as example-owner; an agent session that ignores the lock could use it',
      'the macOS keychain holds a saved git password for github.com; an agent session could use it',
      `${OWNER_KEY} has no passphrase; add one with: ssh-keygen -p -f ${OWNER_KEY}`,
    ]);
  });

  it('reads the stored gh login, not a token in the environment', async () => {
    const sys = exposed();
    sys.env = { GH_TOKEN: 'ghp_agent', GITHUB_TOKEN: 'x', KEEP: '1' };
    await exposure(sys, AGENT);
    const call = sys.calls.find((c) => c.command === 'gh');
    assert.deepEqual(call?.env, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, KEEP: '1' });
  });

  it('ignores gh signed in as the agent', async () => {
    const sys = new FakeSys().ready();
    sys.ghToken = 'ghp_good';
    assert.equal((await exposure(sys, AGENT)).ghLogin, undefined);
  });

  it('names a gh login GitHub will not name', async () => {
    const sys = new FakeSys();
    sys.ghToken = 'gho_stale';
    assert.equal((await exposure(sys, AGENT)).ghLogin, 'an account GitHub could not name');
    sys.http = () => Promise.reject(new Error('offline'));
    assert.equal((await exposure(sys, AGENT)).ghLogin, 'an account GitHub could not name');
  });

  it('finds nothing on a clean Mac', async () => {
    assert.deepEqual(exposureLines(await exposure(new FakeSys().ready(), AGENT)), []);
  });
});

describe('lockOwnerAway', () => {
  it('signs gh out and removes the git password when told to', async () => {
    const sys = exposed();
    const out = await lock(sys, ['y', 'y']);
    assert.deepEqual(out, [
      '✓ gh signed out of example-owner',
      '✓ removed the saved git password for github.com',
      `! ${OWNER_KEY} has no passphrase; add one with: ssh-keygen -p -f ${OWNER_KEY}`,
    ]);
    assert.equal(sys.ghToken, undefined);
    assert.equal(sys.gitPassword, false);
    assert.deepEqual(sys.calls.find((c) => c.args[1] === 'logout')?.args, ['auth', 'logout', '-h', 'github.com', '-u', 'example-owner']);
  });

  it('leaves them in place when declined', async () => {
    const sys = exposed();
    const out = await lock(sys, ['n', 'n']);
    assert.deepEqual(out.slice(0, 2), ['! gh stays signed in as example-owner', '! the saved git password for github.com stays in the keychain']);
    assert.equal(sys.ghToken, 'gho_owner');
    assert.equal(sys.gitPassword, true);
  });

  it('says so when removing fails', async () => {
    const sys = exposed();
    sys.execOverride = (call) => {
      if (call.command === 'gh' && call.args[1] === 'logout') return { code: 1, stdout: '', stderr: 'no such account\n' };
      if (call.command === 'git' && call.args[0] === 'credential-osxkeychain') return { code: 0, stdout: '', stderr: '' };
      return undefined;
    };
    const out = await lock(sys, ['y', 'y']);
    assert.deepEqual(out.slice(0, 2), ['! gh could not sign out: no such account', '! the saved git password for github.com is still in the keychain']);
  });

  it('says when there is nothing to lock away', async () => {
    assert.deepEqual(await lock(new FakeSys().ready(), []), ['✓ nothing of the owner here for an agent session to reach']);
  });
});
