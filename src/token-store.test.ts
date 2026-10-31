import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathsFor, readToken, sessionScript } from './agent.ts';
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
    assert.deepEqual([...sys.keychain], [['process-rules/ExampleBot', TOKEN]]);
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

  it('gives the session file the command it has always run', () => {
    assert.equal(KEYCHAIN.readCommand(AGENT), '/usr/bin/security find-generic-password -s process-rules -a ExampleBot -w 2>/dev/null');
    assert.equal(KEYCHAIN.item(AGENT), 'service process-rules, account ExampleBot');
    assert.match(sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)), /^export GH_TOKEN="\$\(\/usr\/bin\/security find-generic-password -s process-rules -a ExampleBot -w 2>\/dev\/null\)"$/m);
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
      "process-rules supports macOS only, where the keychain holds the agent's token; this machine runs linux",
    );
  });
});
