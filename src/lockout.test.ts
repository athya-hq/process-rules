import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, HOME, NOW } from './fake.test.ts';
import { declinedPath, desktopAppStarted, exposure, exposureFindings, keyFindings, movedFindings, movedPath, ownerFixes, readDeclined, readMoved, recordMove, removeGitPassword, setAside, signOut } from './lockout.ts';

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

/** What machine does after the yes: signs `logins` out of gh and records the move; the owner's steps it returns. */
function lock(sys: FakeSys, logins: string[]) {
  return recordMove(sys, AGENT, logins.filter((login) => signOut(sys, login) === undefined));
}

describe('exposure', () => {
  it("finds the owner's gh accounts, saved git password and open keys, not the agents'", () => {
    const found = exposure(exposed(), AGENT);
    assert.deepEqual(found, { ghLogins: ['example-owner', 'old-owner'], gitPassword: true, openKeys: [OWNER_KEY, `${HOME}/.ssh/work_signing`], sshLogin: undefined });
    assert.deepEqual(exposureFindings(found, HOME), [
      { mark: '▲', text: 'gh is signed in as example-owner', fix: 'niyam machine' },
      { mark: '▲', text: 'gh is signed in as old-owner', fix: 'niyam machine' },
      { mark: '▲', text: 'a saved git password for github.com', fix: 'niyam machine' },
      { mark: '▲', text: '~/.ssh/id_ed25519 has no passphrase', fix: 'ssh-keygen -p -f ~/.ssh/id_ed25519' },
      { mark: '▲', text: '~/.ssh/work_signing has no passphrase', fix: 'ssh-keygen -p -f ~/.ssh/work_signing' },
    ]);
    assert.deepEqual(keyFindings(found, HOME), exposureFindings(found, HOME).slice(3), "machine's: the keys alone");
  });

  it("reads the owner's stored gh logins, not an agent session's", () => {
    const sys = exposed();
    sys.env = { GH_TOKEN: 'ghp_agent', GITHUB_TOKEN: 'x', GH_CONFIG_DIR: '/agent/gh', KEEP: '1' };
    exposure(sys, AGENT);
    const call = sys.calls.find((c) => c.command === 'gh');
    assert.deepEqual(call?.env, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: undefined, KEEP: '1' });
  });

  it("spares the signing keys of agents set up in either folder, the old one's included (P-55)", () => {
    const sys = new FakeSys().ready();
    sys.files.set(`${HOME}/.config/niyam/newbot/session.sh`, '');
    sys.files.set(`${HOME}/.ssh/newbot_signing`, 'open:agent');
    sys.files.set(`${HOME}/.config/process-rules/oldbot/session.sh`, '');
    sys.files.set(`${HOME}/.ssh/oldbot_signing`, 'open:agent');
    sys.files.set(`${HOME}/.ssh/id_ed25519`, 'open:key');
    assert.deepEqual(exposure(sys, AGENT).openKeys, [`${HOME}/.ssh/id_ed25519`]);
  });

  it("still checks an owner key named like the launcher's, records' or locked gh folder, in either config folder", () => {
    const sys = new FakeSys().ready();
    for (const dir of ['niyam', 'process-rules']) {
      sys.files.set(`${HOME}/.config/${dir}/bin/x`, '');
      sys.files.set(`${HOME}/.config/${dir}/sessions/s.json`, '{}');
      sys.mkdir(`${HOME}/.config/${dir}/locked/gh`);
    }
    for (const name of ['bin', 'sessions', 'locked']) sys.files.set(`${HOME}/.ssh/${name}_signing`, 'open:owner');
    assert.deepEqual(exposure(sys, AGENT).openKeys, ['bin', 'sessions', 'locked'].map((name) => `${HOME}/.ssh/${name}_signing`));
  });

  it('spares the key of an agent named like one of those folders, where its session file is', () => {
    const sys = new FakeSys().ready();
    sys.files.set(`${HOME}/.config/niyam/bin/session.sh`, '# the agent "bin"');
    sys.files.set(`${HOME}/.config/niyam/bin/niyam`, '');
    sys.files.set(`${HOME}/.ssh/bin_signing`, 'open:agent');
    sys.files.set(`${HOME}/.ssh/locked_signing`, 'open:owner');
    assert.deepEqual(exposure(sys, AGENT).openKeys, [`${HOME}/.ssh/locked_signing`]);
  });

  it("spares the signing key of an agent whose folder is empty", () => {
    const sys = new FakeSys().ready();
    sys.mkdir(`${HOME}/.config/process-rules/emptybot`);
    sys.files.set(`${HOME}/.ssh/emptybot_signing`, 'open:agent');
    assert.deepEqual(exposure(sys, AGENT).openKeys, []);
  });

  it('finds nothing on a clean Mac', () => {
    assert.deepEqual(exposureFindings(exposure(new FakeSys().ready(), AGENT), HOME), []);
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

  it('names the account SSH reaches GitHub as, as fine: agent sessions refuse SSH', () => {
    const sys = greeted('example-owner');
    const found = exposure(sys, AGENT);
    assert.equal(found.sshLogin, 'example-owner');
    assert.deepEqual(exposureFindings(found, HOME), [{ mark: '✓', text: 'ssh reaches GitHub as example-owner; agent sessions refuse SSH' }]);
    const ssh = sys.calls.find((c) => c.command === 'ssh');
    assert.deepEqual(ssh?.args, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=5', 'git@github.com'], 'never asks for a passphrase, and never adds to or rewrites known_hosts, nor leaves a shared-connection socket');
    assert.equal(ssh?.env?.GH_TOKEN, undefined);
  });

  it("is no exposure when SSH reaches GitHub as the agent", () => {
    assert.equal(exposure(greeted('examplebot'), AGENT).sshLogin, undefined);
  });

});

describe('locking the owner away', () => {
  it('signs every owner account out of gh, and removes the git password', () => {
    const sys = exposed();
    assert.equal(signOut(sys, 'example-owner'), undefined);
    assert.equal(signOut(sys, 'old-owner'), undefined);
    assert.equal(removeGitPassword(sys), true);
    assert.deepEqual(sys.ghAccounts, [AGENT]);
    assert.equal(sys.gitPassword, false);
    assert.deepEqual(sys.calls.find((c) => c.args[1] === 'logout')?.args, ['auth', 'logout', '-h', 'github.com', '-u', 'example-owner']);
    assert.equal(sys.calls.find((c) => c.command === 'git')?.input, 'protocol=https\nhost=github.com\n\n');
  });

  it('says what went wrong', () => {
    const sys = exposed();
    sys.execOverride = (call) => {
      if (call.command === 'gh' && call.args[1] === 'logout') return { code: 1, stdout: '', stderr: call.args[5] === 'old-owner' ? '' : 'no such account\n' };
      if (call.command === 'git' && call.args[0] === 'credential-osxkeychain') return { code: 0, stdout: '', stderr: '' };
      return undefined;
    };
    assert.equal(signOut(sys, 'example-owner'), 'no such account');
    assert.equal(signOut(sys, 'old-owner'), 'exit 1');
    assert.equal(removeGitPassword(sys), false, 'still in the keychain');
  });

  it('removes what was declined before, once the owner says yes', () => {
    const sys = exposed();
    sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: ['example-owner'], gitPassword: true }));
    assert.deepEqual(recordMove(sys, AGENT, []), []);
    assert.equal(sys.exists(declinedPath(HOME, AGENT)), false);
    assert.equal(sys.exists(movedPath(HOME, AGENT)), false, 'nothing moved');
  });

  describe('records an older release kept in the old folder (P-55)', () => {
    const OLD_DIR = `${HOME}/.config/process-rules/examplebot`;

    it('reads what was declined, and the last move, from the old folder where the new one has none, and the new one first', () => {
      const sys = new FakeSys();
      assert.equal(declinedPath(HOME, AGENT), `${HOME}/.config/niyam/examplebot/lockout-declined.json`);
      assert.equal(declinedPath(HOME, AGENT, true), `${OLD_DIR}/lockout-declined.json`);
      assert.equal(movedPath(HOME, AGENT), `${HOME}/.config/niyam/examplebot/gh-moved.json`);
      sys.files.set(`${OLD_DIR}/lockout-declined.json`, JSON.stringify({ ghLogins: ['example-owner'], gitPassword: true }));
      sys.files.set(`${OLD_DIR}/gh-moved.json`, JSON.stringify({ at: NOW.toISOString(), logins: ['example-owner'] }));
      assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: ['example-owner'], gitPassword: true });
      assert.deepEqual(readMoved(sys, AGENT), { at: NOW.toISOString(), logins: ['example-owner'] });
      sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: [], gitPassword: false }));
      sys.files.set(movedPath(HOME, AGENT), JSON.stringify({ at: NOW.toISOString(), logins: ['other-owner'] }));
      assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: [], gitPassword: false });
      assert.deepEqual(readMoved(sys, AGENT)?.logins, ['other-owner']);
    });

    it('removes what was declined in either folder once the owner says yes, and records the move in the new one', () => {
      const sys = exposed();
      sys.files.set(declinedPath(HOME, AGENT, true), JSON.stringify({ ghLogins: ['example-owner'], gitPassword: true }));
      sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: ['example-owner'], gitPassword: true }));
      recordMove(sys, AGENT, ['example-owner']);
      assert.equal(sys.exists(declinedPath(HOME, AGENT, true)), false);
      assert.equal(sys.exists(declinedPath(HOME, AGENT)), false);
      assert.equal(sys.exists(movedPath(HOME, AGENT)), true);
      assert.equal(sys.exists(`${OLD_DIR}/gh-moved.json`), false);
    });
  });
});

describe('a declined lockout', () => {
  const found = { ghLogins: ['example-owner', 'new-owner'], gitPassword: true, openKeys: [OWNER_KEY], sshLogin: undefined };

  it('sets aside the declined logins and password, and keeps a login signed in since', () => {
    const { left, kept } = setAside(found, { ghLogins: ['Example-Owner'], gitPassword: true });
    assert.deepEqual(left, { ghLogins: ['new-owner'], gitPassword: false, openKeys: [OWNER_KEY], sshLogin: undefined });
    assert.deepEqual(kept, [
      'gh stays signed in as example-owner, as you chose',
      'the saved git password for github.com stays, as you chose',
    ]);
  });

  it('still warns about a git password saved after the owner declined only gh', () => {
    assert.equal(setAside(found, { ghLogins: ['example-owner'], gitPassword: false }).left.gitPassword, true);
  });

  it('reads no record, or one it cannot parse, as nothing declined', () => {
    const sys = new FakeSys().ready();
    assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: [], gitPassword: false });
    sys.files.set(declinedPath(HOME, AGENT), '{not json');
    assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: [], gitPassword: false });
    sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: ['a', 3], gitPassword: 'yes' }));
    assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: ['a'], gitPassword: false });
    sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: 'a' }));
    assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: [], gitPassword: false });
  });
});

/** The Mac with the Claude desktop app running since `started`. */
function since(sys: FakeSys, started: Date): FakeSys {
  sys.appStarted = started;
  return sys;
}

describe('moving gh to the agent', () => {
  const STEPS = ownerFixes(['example-owner', 'old-owner']);

  it('gives the two owner steps, each with its fix, and records the move', () => {
    const sys = exposed();
    assert.deepEqual(lock(sys, ['example-owner', 'old-owner']), STEPS);
    assert.deepEqual(STEPS, [
      { mark: '▲', text: "the Claude desktop app still holds example-owner or old-owner's gh token", fix: 'restart the app' },
      { mark: '▲', text: "GitHub still accepts example-owner or old-owner's old gh token", fix: 'revoke GitHub CLI at https://github.com/settings/applications' },
    ]);
    assert.deepEqual(readMoved(sys, AGENT), { at: NOW.toISOString(), logins: ['example-owner', 'old-owner'] });
    assert.equal(sys.modes.get(movedPath(HOME, AGENT)), 0o600);
  });

  it('names only the accounts it signed out, and nothing when none', () => {
    assert.deepEqual(lock(exposed(), ['old-owner']), ownerFixes(['old-owner']));
    const none = exposed();
    assert.deepEqual(lock(none, []), []);
    assert.equal(none.exists(movedPath(HOME, AGENT)), false);
  });

  it('keeps the accounts of a move the desktop app has not restarted since', async () => {
    const sys = exposed();
    sys.files.set(movedPath(HOME, AGENT), JSON.stringify({ at: new Date(NOW.getTime() - 60_000).toISOString(), logins: ['first-owner', 'Old-Owner'] }));
    sys.appStarted = new Date(NOW.getTime() - 120_000);
    lock(sys, ['example-owner', 'old-owner']);
    assert.deepEqual(readMoved(sys, AGENT)?.logins, ['first-owner', 'example-owner', 'old-owner']);
    sys.files.set(movedPath(HOME, AGENT), JSON.stringify({ at: new Date(NOW.getTime() - 60_000).toISOString(), logins: ['first-owner'] }));
    sys.appStarted = new Date(NOW.getTime() - 30_000);
    sys.ghAccounts = ['example-owner'];
    lock(sys, ['example-owner']);
    assert.deepEqual(readMoved(sys, AGENT)?.logins, ['example-owner'], 'restarted since: the earlier move is done');
  });

  it('gives no steps when gh could not sign out', () => {
    const sys = exposed();
    sys.execOverride = (call) => (call.command === 'gh' && call.args[1] === 'logout' ? { code: 1, stdout: '', stderr: 'no\n' } : undefined);
    assert.deepEqual(lock(sys, ['example-owner', 'old-owner']), []);
  });

  it("reads the desktop app's start time, not its helpers'", () => {
    const started = new Date('2026-10-28T09:30:15Z');
    assert.equal(desktopAppStarted(since(new FakeSys().ready(), started))?.getTime(), started.getTime());
    assert.equal(desktopAppStarted(new FakeSys().ready()), undefined, 'not running, or ps cannot say');
  });

  it('gives doctor the steps only while the app started before the move', () => {
    const sys = exposed();
    lock(sys, ['example-owner', 'old-owner']);
    assert.deepEqual(movedFindings(since(sys, new Date(NOW.getTime() - 60_000)), AGENT), STEPS);
    assert.deepEqual(movedFindings(since(exposed(), new Date(NOW.getTime() - 60_000)), AGENT), [], 'no move recorded');
    assert.deepEqual(movedFindings(since(sys, new Date(NOW.getTime() + 60_000)), AGENT), [], 'restarted since');
    sys.appStarted = undefined;
    assert.deepEqual(movedFindings(sys, AGENT), [], 'not running');
  });

  it('reads no record, or a broken one, as no move', () => {
    const sys = new FakeSys().ready();
    assert.equal(readMoved(sys, AGENT), undefined);
    for (const text of ['{not json', JSON.stringify({ at: 'soon', logins: ['a'] }), JSON.stringify({ at: NOW.toISOString(), logins: [] })]) {
      sys.files.set(movedPath(HOME, AGENT), text);
      assert.equal(readMoved(sys, AGENT), undefined, text);
    }
  });
});
