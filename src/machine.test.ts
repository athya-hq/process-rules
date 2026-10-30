import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathsFor, sessionScript } from './agent.ts';
import { AGENT, AGENT_ID, CLASSIC, FakeSys, HOME, KEY, PRIVATE_KEY, PUBLIC_KEY, TOKEN, capture } from './fake.test.ts';
import { TOKEN_PAGE, machine, tokenInstructions } from './machine.ts';

const SESSION = `${HOME}/.config/process-rules/examplebot/session.sh`;

/** A machine with nothing set up, answering yes to everything. */
function fresh(): FakeSys {
  const sys = new FakeSys();
  sys.answers = ['y', 'y', 'y', 'y'];
  sys.secrets = [TOKEN];
  sys.acceptToken(TOKEN, AGENT);
  let registered = false;
  sys.route('POST', '/user/ssh_signing_keys', () => {
    registered = true;
    return { status: 201, json: {} };
  });
  sys.route('GET', '/user/ssh_signing_keys', () => ({
    status: 200,
    json: registered ? [{ key: 'ssh-ed25519 AAAAkey' }] : [],
  }));
  return sys;
}

async function setUp(sys: FakeSys, named?: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await machine(sys, io, named), out, err };
}

describe('machine', () => {
  it('sets up a fresh machine', async () => {
    const sys = fresh();
    const { code, out, err } = await setUp(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.equal(sys.token(AGENT), TOKEN);
    assert.equal(sys.files.get(SESSION), sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    assert.deepEqual(sys.opened, [TOKEN_PAGE]);
    assert.ok(!out.join('\n').includes(TOKEN), 'the token is never printed');
    assert.equal(out.at(-1), `machine: done. Agent sessions act as ExampleBot once they source ${SESSION}.`);

    const register = sys.requests.find((r) => r.method === 'POST');
    assert.deepEqual(register, {
      url: 'https://api.github.com/user/ssh_signing_keys',
      method: 'POST',
      token: TOKEN,
      body: { title: 'process-rules signing', key: PUBLIC_KEY },
    });
    const lists = sys.requests.filter((r) => r.url.endsWith('/ssh_signing_keys') && r.method === 'GET');
    assert.deepEqual(
      lists.map((r) => [r.url, r.token]),
      [['https://api.github.com/user/ssh_signing_keys', TOKEN], ['https://api.github.com/user/ssh_signing_keys', TOKEN]],
      'reads the fresh list with the token, not the cached public one',
    );
    assert.equal(sys.modes.get(SESSION), 0o600);
    assert.ok(sys.dirs.includes(`${HOME}/.ssh`));
    assert.ok(sys.dirs.includes(`${HOME}/.config/process-rules/examplebot/gh`));
    const keygen = sys.calls.find((c) => c.command === 'ssh-keygen');
    assert.deepEqual(keygen?.args, ['-q', '-t', 'ed25519', '-C', 'ExampleBot signing', '-N', '', '-f', KEY]);
    assert.ok(!sys.calls.some((c) => c.command === 'git' && c.args[0] !== 'rev-parse'), 'touches no repository');
  });

  it("ends by offering to lock the owner's credentials away", async () => {
    const sys = new FakeSys().ready();
    sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    sys.ghAccounts = ['example-owner'];
    sys.gitPassword = true;
    sys.files.set(`${HOME}/.ssh/id_ed25519`, 'open:key');
    sys.answers = ['y', 'y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(sys.asked, [
      'gh is signed in as example-owner. Sign it out, so agent sessions cannot use it? (gh auth login brings it back) [y/N] ',
      'The macOS keychain holds a saved git password for github.com. Remove it? [y/N] ',
    ]);
    assert.deepEqual(out.slice(-4), [
      '✓ gh signed out of example-owner',
      '✓ removed the saved git password for github.com',
      `! ${HOME}/.ssh/id_ed25519 has no passphrase; add one with: ssh-keygen -p -f ${HOME}/.ssh/id_ed25519`,
      `machine: done. Agent sessions act as ExampleBot once they source ${SESSION}.`,
    ]);
    assert.deepEqual(sys.ghAccounts, []);
  });

  it('needs no repository when the agent is named', async () => {
    const sys = fresh();
    sys.inRepo = false;
    sys.files.clear();
    assert.equal((await setUp(sys, AGENT)).code, 0);
    assert.ok(!sys.calls.some((c) => c.command === 'git'));
  });

  it('skips what is already done', async () => {
    const sys = new FakeSys().ready();
    sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    const { code } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(sys.asked, []);
    assert.ok(!sys.calls.some((c) => c.command === 'ssh-keygen' && c.args[0] !== '-y'));
  });

  it('falls back to the browser when the API cannot add the key', async () => {
    const sys = fresh();
    let added = false;
    sys.route('POST', '/user/ssh_signing_keys', { status: 403, json: {} });
    sys.route('GET', '/user/ssh_signing_keys', () => ({
      status: 200,
      json: added ? [{ key: 'ssh-ed25519 AAAAkey' }] : [],
    }));
    const ask = sys.ask.bind(sys);
    sys.ask = (question) => {
      if (question.startsWith('Press Enter')) added = true;
      return ask(question);
    };
    sys.answers = ['y', 'y', 'y', '', 'y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.ok(out.includes("GitHub's API refused (HTTP 403). Add it in the browser, signed in as ExampleBot:"));
    assert.ok(out.includes('  ssh-ed25519 AAAAkey ExampleBot signing'));
    assert.deepEqual(sys.opened.at(-1), 'https://github.com/settings/ssh/new');
  });

  it('fails when the key is still not listed', async () => {
    const sys = fresh();
    sys.route('POST', '/user/ssh_signing_keys', { status: 403, json: {} });
    sys.answers = ['y', 'y', 'y', ''];
    const { code, err } = await setUp(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, ["machine: GitHub still does not list the key as ExampleBot's signing key"]);
  });

  it('writes a missing public half from the private key', async () => {
    const sys = fresh();
    sys.files.set(KEY, PRIVATE_KEY);
    const { code } = await setUp(sys);
    assert.equal(code, 0);
    assert.equal(sys.files.get(`${KEY}.pub`), 'ssh-ed25519 AAAAkey ExampleBot signing\n');
    assert.match(sys.asked[0] ?? '', /Write .*\.pub from the private key/);
  });

  it('stops when the public half is declined', async () => {
    const sys = fresh();
    sys.files.set(KEY, PRIVATE_KEY);
    sys.answers = ['n'];
    const { code, err } = await setUp(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ['machine: stopped at "signing key"; nothing after it was changed'] });
  });

  for (const [name, files, problem] of [
    ['unusable', { [KEY]: 'garbage' }, `${KEY} is not a usable private key`],
    ['mismatched', { [KEY]: PRIVATE_KEY, [`${KEY}.pub`]: 'ssh-ed25519 other' }, `${KEY}.pub does not match ${KEY}`],
  ] as const) {
    it(`refuses an ${name} key pair without touching it`, async () => {
      const sys = fresh();
      for (const [path, data] of Object.entries(files)) sys.files.set(path, data);
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`machine: ${problem}; move it aside and run machine again to make a new key`] });
      assert.ok(!sys.calls.some((c) => c.command === 'ssh-keygen' && c.args[0] !== '-y'));
    });
  }

  it('accepts logins that differ only in case', async () => {
    const sys = fresh();
    sys.acceptToken(TOKEN, 'examplebot');
    assert.equal((await setUp(sys)).code, 0);
  });

  it('replaces a stored token that cannot stay', async () => {
    const sys = fresh();
    sys.setToken(AGENT, 'stale');
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.ok(out.includes('The stored token cannot stay: GitHub refuses the token (expired or revoked?). Replacing it.'));
    assert.equal(sys.token(AGENT), TOKEN);
  });

  it('offers to replace a stored token near its end', async () => {
    const sys = fresh();
    const old = 'ghp_old';
    sys.setToken(AGENT, old);
    sys.acceptToken(old, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': '2026-11-05 12:00:00 UTC' });
    sys.answers = ['y', 'y', 'y', 'y', 'y'];
    const { code } = await setUp(sys);
    assert.equal(code, 0);
    assert.ok(sys.asked.includes('The stored token ends in 6 days. Replace it with a new one? [y/N] '));
    assert.equal(sys.token(AGENT), TOKEN);
  });

  it('keeps a stored token near its end when told to', async () => {
    const sys = fresh();
    const old = 'ghp_old';
    sys.setToken(AGENT, old);
    sys.acceptToken(old, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': '2026-11-05 12:00:00 UTC' });
    sys.answers = ['y', 'n', 'y', 'y'];
    assert.equal((await setUp(sys)).code, 0);
    assert.equal(sys.token(AGENT), old);
    assert.deepEqual(sys.opened, []);
  });

  for (const typed of ['examplebot', 'EXAMPLEBOT', 'exampleBOT']) {
    it(`uses GitHub's spelling of the login typed as ${typed}`, async () => {
      const sys = fresh();
      assert.equal((await setUp(sys, typed)).code, 0);
      assert.deepEqual([...sys.keychain.keys()], [`process-rules/${AGENT}`]);
      assert.equal(sys.files.get(SESSION), sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    });
  }

  for (const [name, secret, login, headers, message] of [
    ['an empty paste', '', undefined, CLASSIC, 'machine: GitHub refuses the token (expired or revoked?)'],
    ['a refused token', 'ghp_bad', undefined, CLASSIC, 'machine: GitHub refuses the token (expired or revoked?)'],
    ["the owner's token", 'ghp_owner', 'example-owner', CLASSIC, 'machine: the token acts as example-owner, not ExampleBot'],
    ['a fine-grained token', 'github_pat_x', AGENT, {}, 'machine: it is not a classic token, which process-rules needs (see its docs/decisions.md)'],
    ['a token short of scopes', 'ghp_thin', AGENT, { 'x-oauth-scopes': 'repo' }, 'machine: the token lacks the scopes workflow, read:org, project, write:ssh_signing_key'],
    ['a token that never expires', 'ghp_forever', AGENT, { 'x-oauth-scopes': CLASSIC['x-oauth-scopes'] }, 'machine: the token never expires; create one with an expiry (90 days recommended)'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      sys.secrets = [secret];
      if (login) sys.acceptToken(secret, login, headers);
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
      assert.equal(sys.keychain.size, 0);
    });
  }

  it('says so when the keychain does not take the token', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 1, stdout: '', stderr: '' } : undefined);
    const { code, err } = await setUp(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ['machine: the keychain did not take the token'] });
  });

  it('reports a failed ssh-keygen', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.command === 'ssh-keygen' ? { code: 1, stdout: '', stderr: 'no space\n' } : undefined);
    const { code, err } = await setUp(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ['machine: ssh-keygen failed: no space'] });
  });

  for (const [index, step] of ['signing key', 'token', 'register key', 'session file'].entries()) {
    it(`stops without changing anything more when "${step}" is declined`, async () => {
      const sys = fresh();
      sys.answers = [...Array<string>(index).fill('y'), 'n'];
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`machine: stopped at "${step}"; nothing after it was changed`] });
      assert.equal(sys.files.has(SESSION), false);
    });
  }
});

describe('tokenInstructions', () => {
  it('names the account, the scopes and the expiry', () => {
    const text = tokenInstructions(AGENT).join('\n');
    assert.match(text, /classic token\. In a private window signed in as ExampleBot/);
    assert.match(text, /repo, workflow, read:org, project, write:ssh_signing_key\. Tick nothing else/);
    assert.match(text, /Expiration: 90 days\. doctor warns 14 days before it ends/);
    assert.match(text, /Configure SSO → Authorize/);
  });

  it('opens a page with the scopes filled in', () => {
    assert.equal(
      TOKEN_PAGE,
      'https://github.com/settings/tokens/new?description=process-rules%20agent&scopes=repo,workflow,read:org,project,write:ssh_signing_key',
    );
  });
});
