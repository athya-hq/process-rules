import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathsFor, sessionScript } from './agent.ts';
import { doctor } from './doctor.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, KEY, capture } from './fake.test.ts';

const SESSION = `${HOME}/.config/process-rules/session.sh`;

function healthy(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
  return sys;
}

async function check(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await doctor(sys, io), out, err };
}

describe('doctor', () => {
  it('passes when the machine is set up', async () => {
    assert.deepEqual(await check(healthy()), {
      code: 0,
      out: ['✓ signing key', '✓ token', '✓ key registered', '✓ session file', 'doctor: ready; agent sessions work as AthyaBot'],
      err: [],
    });
  });

  it('refuses a machine never set up, naming every step', async () => {
    const { code, err } = await check(new FakeSys());
    assert.equal(code, 1);
    assert.deepEqual(err, [
      `✗ signing key: ${KEY} is missing`,
      "✗ token: no AthyaBot token in this machine's keychain",
      '✗ key registered: GitHub does not list this key as a signing key of AthyaBot',
      `✗ session file: ${SESSION} is missing`,
      'doctor: agent sessions must not push as AthyaBot until fixed; run process-rules machine',
    ]);
  });

  it('refuses a token GitHub rejects', async () => {
    const sys = healthy();
    sys.keychain.set(AGENT, 'revoked');
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.equal(err[0], '✗ token: GitHub refuses the stored token (expired or revoked?)');
  });

  it("refuses a token that is someone else's", async () => {
    const sys = healthy();
    sys.keychain.set(AGENT, 'owners');
    sys.acceptToken('owners', 'AlokBansal8');
    const { err } = await check(sys);
    assert.equal(err[0], '✗ token: the stored token acts as AlokBansal8, not AthyaBot');
  });

  it('refuses a key GitHub does not list', async () => {
    const sys = healthy();
    sys.route('GET', '/users/AthyaBot/ssh_signing_keys', { status: 200, json: [{ key: 'ssh-ed25519 other' }] });
    const { err } = await check(sys);
    assert.equal(err[0], '✗ key registered: GitHub does not list this key as a signing key of AthyaBot');
  });

  it('refuses a stale session file', async () => {
    const sys = healthy();
    sys.files.set(SESSION, 'old');
    const { err } = await check(sys);
    assert.equal(err[0], `✗ session file: ${SESSION} is out of date`);
  });
});
