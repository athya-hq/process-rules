import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathsFor, readToken, sessionFileIs, sessionScript } from './agent.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, TOKEN } from './fake.test.ts';
import { KEYCHAIN, tokenStore, unsupported } from './token-store.ts';

describe('the macOS keychain', () => {
  it('reads a stored token', () => {
    const sys = new FakeSys();
    sys.setToken(AGENT, TOKEN);
    sys.keychain.set('gh:github.com/Other', 'owners');
    assert.equal(KEYCHAIN.read(sys, AGENT), TOKEN);
    assert.equal(KEYCHAIN.read(sys, 'Other'), undefined);
  });

  it('stores a token through stdin, never argv', () => {
    const sys = new FakeSys();
    assert.equal(KEYCHAIN.store(sys, AGENT, TOKEN), true);
    assert.deepEqual([...sys.keychain], [['niyam/ExampleBot', TOKEN]]);
    const call = sys.calls.find((c) => c.args[0] === '-i');
    assert.ok(call?.input?.includes(TOKEN));
    assert.ok(!call?.args.some((arg) => arg.includes(TOKEN)));
  });

  it('refuses a token with characters the keychain prompt could misread', () => {
    assert.equal(KEYCHAIN.store(new FakeSys(), AGENT, 'a b'), false);
  });

  it('reports a keychain that refused the token', () => {
    const sys = new FakeSys();
    sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 1, stdout: '', stderr: 'no' } : undefined);
    assert.equal(KEYCHAIN.store(sys, AGENT, TOKEN), false);
  });

  it('reports a keychain that said yes but did not keep the token', () => {
    const sys = new FakeSys();
    sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 0, stdout: '', stderr: '' } : undefined);
    assert.equal(KEYCHAIN.store(sys, AGENT, TOKEN), false);
    assert.ok(sys.calls.some((c) => c.args[0] === 'find-generic-password'));
  });

  it('gives the session file a command that reads niyam, then the old process-rules entry', () => {
    const niyam = '/usr/bin/security find-generic-password -s niyam -a ExampleBot -w 2>/dev/null';
    const old = '/usr/bin/security find-generic-password -s process-rules -a ExampleBot -w 2>/dev/null';
    assert.equal(KEYCHAIN.readCommand(AGENT), `${niyam} || ${old}`);
    assert.deepEqual(KEYCHAIN.olderReadCommands?.(AGENT), [old], 'what releases before niyam wrote');
    assert.equal(KEYCHAIN.item(AGENT), 'service niyam, account ExampleBot');
    assert.ok(sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)).split('\n').includes(`export GH_TOKEN="$(${niyam} || ${old})"`));
  });
});

describe('the keychain before niyam (P-50)', () => {
  const withEntries = (entries: Record<string, string>): FakeSys => {
    const sys = new FakeSys();
    sys.keychain.clear();
    for (const [service, token] of Object.entries(entries)) sys.keychain.set(`${service}/${AGENT}`, token);
    return sys;
  };

  it('reads a token held only under the old process-rules service, and says it is only there', () => {
    const sys = withEntries({ 'process-rules': 'ghp_old' });
    assert.equal(KEYCHAIN.read(sys, AGENT), 'ghp_old');
    assert.equal(KEYCHAIN.onlyOlder?.(sys, AGENT), true);
  });

  it('reads the niyam entry first when both are there', () => {
    const sys = withEntries({ niyam: 'ghp_new', 'process-rules': 'ghp_old' });
    assert.equal(KEYCHAIN.read(sys, AGENT), 'ghp_new');
    assert.equal(KEYCHAIN.onlyOlder?.(sys, AGENT), false);
  });

  it('finds nothing when neither is there', () => {
    const sys = withEntries({});
    assert.equal(KEYCHAIN.read(sys, AGENT), undefined);
    assert.equal(KEYCHAIN.onlyOlder?.(sys, AGENT), false);
  });

  it('stores under niyam alone when there is no old entry', () => {
    const sys = withEntries({});
    assert.equal(KEYCHAIN.store(sys, AGENT, 'ghp_new'), true);
    assert.deepEqual(Object.fromEntries(sys.keychain), { 'niyam/ExampleBot': 'ghp_new' });
  });

  it('keeps an old entry in step, so an older CLI never reads a token machine replaced', () => {
    const sys = withEntries({ 'process-rules': 'ghp_old' });
    assert.equal(KEYCHAIN.store(sys, AGENT, 'ghp_new'), true);
    assert.deepEqual(Object.fromEntries(sys.keychain), { 'process-rules/ExampleBot': 'ghp_new', 'niyam/ExampleBot': 'ghp_new' });
  });

  it('reports a keychain that took the new name but not the old one', () => {
    const sys = withEntries({ 'process-rules': 'ghp_old' });
    sys.execOverride = (call) => {
      if (call.args[0] !== '-i') return undefined;
      sys.keychain.set(`niyam/${AGENT}`, 'ghp_new');
      return { code: 0, stdout: '', stderr: '' };
    };
    assert.equal(KEYCHAIN.store(sys, AGENT, 'ghp_new'), false);
  });

  it("takes a session file an older release wrote, one that reads the old entry, as an older one, not a stranger's", () => {
    const paths = pathsFor(HOME, AGENT);
    const { olderReadCommands: _older, ...bare } = KEYCHAIN;
    const older = sessionScript(AGENT, AGENT_ID, paths, KEYCHAIN, '/usr/bin/security find-generic-password -s process-rules -a ExampleBot -w 2>/dev/null');
    assert.equal(sessionFileIs(sessionScript(AGENT, AGENT_ID, paths), AGENT, AGENT_ID, paths), 'current');
    assert.equal(sessionFileIs(older, AGENT, AGENT_ID, paths), 'older');
    assert.equal(sessionFileIs(older.replace('process-rules -a', 'other -a'), AGENT, AGENT_ID, paths), undefined);
    assert.equal(sessionFileIs(sessionScript(AGENT, AGENT_ID, paths), AGENT, AGENT_ID, paths, bare), 'current');
    assert.equal(sessionFileIs(older, AGENT, AGENT_ID, paths, bare), undefined, 'a store with no older names takes no older file');
  });
});

describe('tokenStore', () => {
  it('is the keychain on macOS', () => {
    assert.equal(tokenStore(new FakeSys()), KEYCHAIN);
  });

  it('is none on any other platform, which readToken then finds no token in', () => {
    for (const platform of ['linux', 'win32', 'toString']) {
      const sys = Object.assign(new FakeSys(), { platform });
      sys.setToken(AGENT, TOKEN);
      assert.equal(tokenStore(sys), undefined, platform);
      assert.equal(readToken(sys, AGENT), undefined, platform);
      assert.equal(sys.calls.length, 0, platform);
    }
  });

  it('names macOS as the supported platform', () => {
    assert.equal(
      unsupported(Object.assign(new FakeSys(), { platform: 'linux' })),
      "niyam supports macOS only, where the keychain holds the agent's token; this machine runs linux",
    );
  });
});
