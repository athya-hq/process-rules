import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, HOME, NOW, capture } from './fake.test.ts';
import { declinedPath, desktopAppStarted, exposure, exposureLines, lockOwnerAway, movedLines, movedPath, ownerSteps, readDeclined, readMoved, setAside } from './lockout.ts';

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

  it('records what was declined, beside the session file and private', async () => {
    const sys = exposed();
    const out = await lock(sys, ['y', 'n', 'n']);
    const path = declinedPath(HOME, AGENT);
    assert.equal(path, `${HOME}/.config/process-rules/examplebot/lockout-declined.json`);
    assert.deepEqual(JSON.parse(sys.read(path)), { ghLogins: ['old-owner'], gitPassword: true });
    assert.equal(sys.modes.get(path), 0o600);
    assert.equal(out[3], `  doctor reports what you declined as your choice (${path}); process-rules machine offers again`);
  });

  it('offers again, and accepting clears the record', async () => {
    const sys = exposed();
    await lock(sys, ['n', 'n', 'n']);
    const out = await lock(sys, ['y', 'y', 'y']);
    assert.equal(sys.asked.length, 6, 'asks again on the second run');
    assert.deepEqual(readDeclined(sys, AGENT), { ghLogins: [], gitPassword: false });
    assert.ok(!out.some((line) => line.includes('doctor reports')));
  });

  it('writes no record when nothing was declined', async () => {
    const sys = exposed();
    await lock(sys, ['y', 'y', 'y']);
    assert.equal(sys.exists(declinedPath(HOME, AGENT)), false);
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

describe('a declined lockout', () => {
  const found = { ghLogins: ['example-owner', 'new-owner'], gitPassword: true, openKeys: [OWNER_KEY], sshLogin: undefined };

  it('sets aside the declined logins and password, and keeps a login signed in since', () => {
    const { left, kept } = setAside(found, { ghLogins: ['Example-Owner'], gitPassword: true });
    assert.deepEqual(left, { ghLogins: ['new-owner'], gitPassword: false, openKeys: [OWNER_KEY], sshLogin: undefined });
    assert.deepEqual(kept, [
      'lockout declined: gh stays signed in as example-owner; process-rules machine offers again',
      'lockout declined: the saved git password for github.com stays; process-rules machine offers again',
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
  const STEPS = ownerSteps(['example-owner', 'old-owner']);

  it('ends with the two owner steps, printed together, and records the move', async () => {
    const sys = exposed();
    const out = await lock(sys, ['y', 'y', 'y']);
    assert.deepEqual(out.slice(-3), [`! ${STEPS[0]}`, ...STEPS.slice(1)]);
    assert.deepEqual(STEPS, [
      'two steps only you can do, now that gh here works as the agent:',
      '  1. Restart the Claude desktop app. It keeps the gh token it read before, so its own GitHub actions (Auto-fix, the PR bar) run as example-owner or old-owner until it restarts.',
      '  2. Revoke the old token on GitHub, signed in as example-owner or old-owner: Settings → Applications → Authorized OAuth Apps → GitHub CLI → Revoke (https://github.com/settings/applications). gh auth logout deleted it from this Mac, but GitHub still accepts it.',
    ]);
    assert.deepEqual(readMoved(sys, AGENT), { at: NOW.toISOString(), logins: ['example-owner', 'old-owner'] });
    assert.equal(sys.modes.get(movedPath(HOME, AGENT)), 0o600);
  });

  it('names only the accounts it signed out, and nothing when none', async () => {
    const sys = exposed();
    const out = await lock(sys, ['n', 'y', 'n']);
    assert.ok(out.at(-2)?.includes('run as old-owner until'));
    const none = exposed();
    const kept = await lock(none, ['n', 'n', 'n']);
    assert.ok(!kept.some((line) => line.includes('two steps')));
    assert.equal(none.exists(movedPath(HOME, AGENT)), false);
  });

  it('keeps the accounts of a move the desktop app has not restarted since', async () => {
    const sys = exposed();
    sys.files.set(movedPath(HOME, AGENT), JSON.stringify({ at: new Date(NOW.getTime() - 60_000).toISOString(), logins: ['first-owner', 'Old-Owner'] }));
    sys.appStarted = new Date(NOW.getTime() - 120_000);
    await lock(sys, ['y', 'y', 'n']);
    assert.deepEqual(readMoved(sys, AGENT)?.logins, ['first-owner', 'example-owner', 'old-owner']);
    sys.files.set(movedPath(HOME, AGENT), JSON.stringify({ at: new Date(NOW.getTime() - 60_000).toISOString(), logins: ['first-owner'] }));
    sys.appStarted = new Date(NOW.getTime() - 30_000);
    sys.ghAccounts = ['example-owner'];
    await lock(sys, ['y']);
    assert.deepEqual(readMoved(sys, AGENT)?.logins, ['example-owner'], 'restarted since: the earlier move is done');
  });

  it('prints no steps when gh could not sign out', async () => {
    const sys = exposed();
    sys.execOverride = (call) => (call.command === 'gh' && call.args[1] === 'logout' ? { code: 1, stdout: '', stderr: 'no\n' } : undefined);
    assert.ok(!(await lock(sys, ['y', 'y', 'n'])).some((line) => line.includes('two steps')));
  });

  it("reads the desktop app's start time, not its helpers'", () => {
    const started = new Date('2026-10-28T09:30:15Z');
    assert.equal(desktopAppStarted(since(new FakeSys().ready(), started))?.getTime(), started.getTime());
    assert.equal(desktopAppStarted(new FakeSys().ready()), undefined, 'not running, or ps cannot say');
  });

  it('gives doctor the steps only while the app started before the move', async () => {
    const sys = exposed();
    await lock(sys, ['y', 'y', 'y']);
    assert.deepEqual(movedLines(since(sys, new Date(NOW.getTime() - 60_000)), AGENT), STEPS);
    assert.deepEqual(movedLines(since(exposed(), new Date(NOW.getTime() - 60_000)), AGENT), [], 'no move recorded');
    assert.deepEqual(movedLines(since(sys, new Date(NOW.getTime() + 60_000)), AGENT), [], 'restarted since');
    sys.appStarted = undefined;
    assert.deepEqual(movedLines(sys, AGENT), [], 'not running');
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
