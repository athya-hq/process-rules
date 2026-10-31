import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { launcherPath, pathsFor, sessionScript } from './agent.ts';
import { doctor } from './doctor.ts';
import { AGENT, AGENT_ID, CLASSIC, FakeSys, HOME, KEY, TOKEN, capture } from './fake.test.ts';

const SESSION = `${HOME}/.config/process-rules/examplebot/session.sh`;
const LAUNCHER = launcherPath(HOME);

function healthy(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
  return sys;
}

async function check(sys: FakeSys, named?: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await doctor(sys, io, named), out, err };
}

describe('doctor', () => {
  it('passes when the machine is set up', async () => {
    assert.deepEqual(await check(healthy()), {
      code: 0,
      out: ['✓ signing key', '✓ token', '✓ key registered', '✓ session file', '✓ launcher', 'doctor: ready; agent sessions work as ExampleBot'],
      err: [],
    });
  });

  it("warns when the repo's CODEOWNERS names the owner, and still passes", async () => {
    const sys = healthy();
    sys.files.set('/repo/.github/CODEOWNERS', '* @example-owner\n');
    const { code, err } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(err, [
      '! .github/CODEOWNERS names example-owner in a rule (line 1): GitHub will ask example-owner to review every pull request ExampleBot opens, ' +
        "because ExampleBot authors them and GitHub never asks a pull request's author; run process-rules onboard to remove example-owner from them",
    ]);
  });

  it('refuses a machine never set up, naming every step', async () => {
    const { code, err } = await check(new FakeSys());
    assert.equal(code, 1);
    assert.deepEqual(err, [
      `✗ signing key: ${KEY} is missing`,
      "✗ token: no ExampleBot token in this machine's keychain",
      '✗ key registered: GitHub does not list this key as a signing key of ExampleBot',
      `✗ session file: ${SESSION} is missing`,
      `✗ launcher: ${LAUNCHER} is missing, so the hooks need process-rules and node on their PATH`,
      'doctor: agent sessions must not push as ExampleBot until fixed; run process-rules machine',
    ]);
  });

  it('refuses a token GitHub rejects', async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'revoked');
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.equal(err[0], '✗ token: GitHub refuses the token (expired or revoked?)');
  });

  it("refuses a token that is someone else's", async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'ghp_owners');
    sys.acceptToken('ghp_owners', 'example-owner');
    const { err } = await check(sys);
    assert.equal(err[0], '✗ token: the token acts as example-owner, not ExampleBot');
  });

  it('refuses a fine-grained token', async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'github_pat_x');
    sys.acceptToken('github_pat_x', AGENT, {});
    const { err } = await check(sys);
    assert.equal(err[0], '✗ token: it is not a classic token, which process-rules needs (see its docs/decisions.md)');
  });

  it('warns about a token near its end, and still passes', async () => {
    const sys = healthy();
    sys.acceptToken(TOKEN, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': '2026-11-10 12:00:00 UTC' });
    const { code, err } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(err, ['! the token ends in 11 days; run process-rules machine to replace it']);
  });

  it("uses GitHub's spelling of a login typed in another case", async () => {
    for (const typed of ['examplebot', 'EXAMPLEBOT']) assert.equal((await check(healthy(), typed)).code, 0, typed);
  });

  it("warns about the owner's credentials an agent session could reach, and still passes", async () => {
    const sys = healthy();
    sys.ghAccounts = ['example-owner'];
    sys.gitPassword = true;
    const { code, err } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(err, [
      '! gh is signed in as example-owner; an agent session that ignores the lock could use it',
      '! the macOS keychain holds a saved git password for github.com; an agent session could use it',
    ]);
  });

  it('checks a named agent outside any repository', async () => {
    const sys = healthy();
    sys.inRepo = false;
    sys.files.delete('/repo/.github/process-rules.json');
    assert.equal((await check(sys, AGENT)).code, 0);
  });

  it('refuses a key GitHub does not list', async () => {
    const sys = healthy();
    sys.route('GET', '/users/ExampleBot/ssh_signing_keys', { status: 200, json: [{ key: 'ssh-ed25519 other' }] });
    const { err } = await check(sys);
    assert.equal(err[0], '✗ key registered: GitHub does not list this key as a signing key of ExampleBot');
  });

  it('refuses a key pair whose halves do not match', async () => {
    const sys = healthy();
    sys.files.set(`${KEY}.pub`, 'ssh-ed25519 other');
    const { err } = await check(sys);
    assert.deepEqual(err.slice(0, 2), [
      `✗ signing key: ${KEY}.pub does not match ${KEY}`,
      '✗ key registered: GitHub does not list this key as a signing key of ExampleBot',
    ]);
  });

  it('names a launcher whose node is gone', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === LAUNCHER ? { code: 127, stdout: '', stderr: '/gone/bin/node: not found\n' } : undefined);
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.equal(err[0], `✗ launcher: ${LAUNCHER} does not run (/gone/bin/node: not found); was its node removed?`);
    assert.equal(sys.calls.find((c) => c.command === LAUNCHER)?.env?.PATH, '/usr/bin:/bin', 'runs it without the PATH of this shell');
  });

  it('names a launcher that fails without saying why', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === LAUNCHER ? { code: 3, stdout: '', stderr: '' } : undefined);
    assert.equal((await check(sys)).err[0], `✗ launcher: ${LAUNCHER} does not run (exit 3); was its node removed?`);
  });

  it('accepts a token whose login differs only in case', async () => {
    const sys = healthy();
    sys.acceptToken(TOKEN, 'examplebot');
    assert.equal((await check(sys)).code, 0);
  });

  it('names each check GitHub could not answer, and still runs the rest', async () => {
    const sys = healthy();
    sys.http = () => Promise.reject(new Error('rate limited'));
    const { code, out, err } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(out, ['✓ signing key', '✓ launcher']);
    assert.deepEqual(err.slice(0, 3), [
      '✗ token: cannot ask GitHub: rate limited',
      '✗ key registered: cannot ask GitHub: rate limited',
      '✗ session file: cannot ask GitHub: rate limited',
    ]);
  });

  it('reports a thrown non-error from GitHub', async () => {
    const sys = healthy();
    sys.http = () => Promise.reject('down');
    assert.equal((await check(sys)).err[0], '✗ token: cannot ask GitHub: down');
  });

  it('refuses a stale session file', async () => {
    const sys = healthy();
    sys.files.set(SESSION, 'old');
    const { err } = await check(sys);
    assert.equal(err[0], `✗ session file: ${SESSION} is out of date`);
  });
});
