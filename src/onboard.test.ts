import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, TOKEN, capture } from './fake.test.ts';
import { HOOK_COMMAND, HOOKS_PATH, WORKFLOW_PATH, onboard, workflow } from './onboard.ts';

const SETTINGS = `${ROOT}/.github/process-rules.json`;
const HOOKS = `${ROOT}/${HOOKS_PATH}`;
const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
const REPO = '/repos/example-org/example-app';
const PUSH = { status: 200, json: { default_branch: 'main', permissions: { push: true } } };
const VERIFIED = {
  status: 200,
  json: { committer: { login: AGENT }, commit: { verification: { verified: true, reason: 'valid' } } },
};

/** A Mac set up for the agent, a client repo with nothing in it yet, the agent able to push, yes to everything. */
function fresh(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.delete(SETTINGS);
  sys.route('GET', '/users/example-owner', { status: 200, json: { id: 1, login: 'example-owner' } });
  sys.route('GET', REPO, PUSH);
  sys.route('GET', `${REPO}/commits/abc123`, VERIFIED);
  sys.answers = Array<string>(6).fill('y');
  return sys;
}

async function run(sys: FakeSys, named: string[] = ['example-owner', AGENT]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await onboard(sys, io, named), out, err };
}

describe('onboard', () => {
  it('writes the files, finds the agent can push, and proves a Verified commit', async () => {
    const sys = fresh();
    const { code, out, err } = await run(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.equal(sys.files.get(SETTINGS), '{\n  "owner": "example-owner",\n  "agent": "ExampleBot"\n}\n');
    assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? ''), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] },
    });
    assert.equal(sys.files.get(WORKFLOW), workflow('main'));
    assert.deepEqual(sys.dirs.filter((d) => d.startsWith(ROOT)), [`${ROOT}/.github`, `${ROOT}/.claude`, `${ROOT}/.github/workflows`]);
    assert.ok(out.includes('✓ ExampleBot can push to example-org/example-app'));
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by ExampleBot'));
    assert.ok(out.includes('Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
    assert.equal(
      out.at(-1),
      'onboard: done. Commit .github/process-rules.json, .claude/settings.json and .github/workflows/process-rules.yml; agent sessions then work as ExampleBot.',
    );
    const git = sys.calls.filter((c) => c.command === 'git' && c.env);
    assert.deepEqual(git.map((c) => c.args.slice(0, 2).join(' ')), ['init -q', 'fetch -q', 'commit-tree -S', 'push -q', 'push -q']);
    assert.equal(git[0]?.env?.GH_TOKEN, TOKEN);
    assert.equal(git[0]?.env?.GIT_COMMITTER_EMAIL, '42+ExampleBot@users.noreply.github.com');
    assert.deepEqual(sys.calls.at(-1)?.args, ['-rf', '/tmp/verify']);
    assert.ok(sys.requests.filter((r) => r.url.includes(REPO)).every((r) => r.token === TOKEN), 'asks GitHub as the agent');
  });

  it("uses GitHub's spelling of logins typed in another case", async () => {
    const sys = fresh();
    sys.route('GET', '/users/EXAMPLE-OWNER', { status: 200, json: { id: 1, login: 'example-owner' } });
    assert.equal((await run(sys, ['EXAMPLE-OWNER', 'examplebot'])).code, 0);
    assert.match(sys.files.get(SETTINGS) ?? '', /"owner": "example-owner",\n {2}"agent": "ExampleBot"/);
  });

  it('reads the accounts from existing settings, and skips what is done', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
    sys.files.set(WORKFLOW, workflow('main'));
    const { code } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.asked.map((q) => q.split(' ')[0]), ['Push']);
  });

  it('keeps the hooks a client already has', async () => {
    const sys = fresh();
    const own = { hooks: [{ type: 'command', command: 'echo hi' }] };
    sys.files.set(HOOKS, JSON.stringify({ env: { A: '1' }, hooks: { SessionStart: [own], Stop: [own] } }));
    await run(sys);
    assert.deepEqual(JSON.parse(sys.files.get(HOOKS) ?? ''), {
      env: { A: '1' },
      hooks: { SessionStart: [own, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }], Stop: [own] },
    });
  });

  it('replaces a workflow that differs', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, 'old');
    sys.route('GET', REPO, { status: 200, json: { default_branch: 'trunk', permissions: { push: true } } });
    await run(sys);
    assert.ok(sys.asked.some((q) => q.startsWith('Replace .github/workflows/process-rules.yml')));
    assert.match(sys.files.get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
  });

  it('refuses inside an agent session', async () => {
    const sys = fresh();
    sys.env.PROCESS_RULES_AGENT = AGENT;
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['onboard: run it in your own terminal, not in an agent session'] });
  });

  for (const [name, named, change, message] of [
    ['without accounts the first time', [], () => undefined, 'onboard: name the owner and the agent account: process-rules onboard <owner> <agent>'],
    ['the same account twice', ['example-owner', 'Example-Owner'], () => undefined, 'onboard: the owner and the agent must be different accounts'],
    [
      'accounts other than the settings name',
      ['someone', AGENT],
      (sys: FakeSys) => sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT })),
      'onboard: .github/process-rules.json already names owner example-owner and agent ExampleBot; edit or delete it to change them',
    ],
    [
      'a Mac not set up for the agent',
      ['example-owner', AGENT],
      (sys: FakeSys) => sys.keychain.clear(),
      'onboard: this Mac is not set up for ExampleBot; run process-rules machine ExampleBot, then onboard again',
    ],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      sys.route('GET', '/users/Example-Owner', { status: 200, json: { id: 1, login: 'example-owner' } });
      change(sys);
      const { code, err } = await run(sys, [...named]);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
    });
  }

  it('refuses a name that is not a login', async () => {
    await assert.rejects(run(fresh(), ['-x', AGENT]), /"-x" is not a GitHub login/);
  });

  it('refuses hooks settings that are not an object', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '[]');
    await assert.rejects(run(sys), /\.claude\/settings\.json is not a JSON object/);
  });

  it('refuses a Mac whose key is missing', async () => {
    const sys = fresh();
    sys.files.delete(`${sys.home}/.ssh/examplebot_signing`);
    assert.equal((await run(sys)).code, 1);
  });

  describe('agent access', () => {
    it('gives an organisation member access through gh', async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations', { status: 200, json: [] });
      sys.execOverride = (call) => {
        if (call.command !== 'gh') return undefined;
        added = true;
        return { code: 0, stdout: '', stderr: '' };
      };
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(sys.calls.find((c) => c.command === 'gh')?.args, [
        'api', '-X', 'PUT', 'repos/example-org/example-app/collaborators/ExampleBot', '-f', 'permission=push',
      ]);
    });

    it('invites, then accepts the invitation as the agent', async () => {
      const sys = fresh();
      let accepted = false;
      let invited = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations', () => ({
        status: 200,
        json: invited ? [{ id: 9, repository: { full_name: 'Example-Org/Example-App' } }, { id: 'x' }, null] : [],
      }));
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      sys.execOverride = (call) => {
        if (call.command !== 'gh') return undefined;
        invited = true;
        return { code: 0, stdout: '', stderr: '' };
      };
      sys.answers = Array<string>(7).fill('y');
      const { code } = await run(sys);
      assert.equal(code, 0);
      assert.equal(sys.requests.find((r) => r.method === 'PATCH')?.token, TOKEN);
    });

    it('accepts a pending invitation without inviting again', async () => {
      const sys = fresh();
      let accepted = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      assert.equal((await run(sys)).code, 0);
      assert.ok(!sys.calls.some((c) => c.command === 'gh'));
    });

    for (const [name, setUp, message] of [
      [
        'gh failing to add the agent',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations', { status: 500, json: null });
          sys.execOverride = (call) => (call.command === 'gh' ? { code: 1, stdout: '', stderr: 'HTTP 403\n' } : undefined);
        },
        ['onboard: gh could not add ExampleBot: HTTP 403', '  Add it yourself: example-org/example-app → Settings → Collaborators → Add people → ExampleBot, role Write.'],
      ],
      [
        'an invitation GitHub will not accept',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
          sys.route('PATCH', '/user/repository_invitations/9', { status: 403, json: null });
        },
        ['onboard: GitHub did not accept the invitation (HTTP 403)'],
      ],
      [
        'an agent still without access',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations', { status: 200, json: [] });
          sys.execOverride = (call) => (call.command === 'gh' ? { code: 0, stdout: '', stderr: '' } : undefined);
        },
        ['onboard: ExampleBot still cannot see example-org/example-app; check the invitation reached ExampleBot'],
      ],
      [
        'read-only access',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 200, json: { default_branch: 'main', permissions: { push: false } } }),
        ['onboard: ExampleBot can read example-org/example-app but not push; give it the Write role'],
      ],
      [
        'an organisation requiring SAML',
        (sys: FakeSys) =>
          sys.route('GET', REPO, {
            status: 403,
            json: { message: 'Resource protected by organization SAML enforcement.' },
            headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example-org/sso?authorization_request=abc' },
          }),
        ['onboard: the organisation requires SAML single sign-on; authorise the token for it at https://github.com/orgs/example-org/sso?authorization_request=abc'],
      ],
      [
        'an organisation blocking classic tokens',
        (sys: FakeSys) =>
          sys.route('GET', REPO, {
            status: 403,
            json: { message: 'example-org forbids access via a personal access tokens (classic).' },
          }),
        [
          'onboard: the organisation does not allow classic tokens ("example-org forbids access via a personal access tokens (classic)."); an organisation owner can allow them under Settings → Personal access tokens',
        ],
      ],
      [
        'any other refusal',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 401, json: null }),
        ['onboard: GitHub refused (HTTP 401)'],
      ],
      [
        'a refusal with a message',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 451, json: { message: 'blocked' } }),
        ['onboard: GitHub refused (HTTP 451: blocked)'],
      ],
    ] as const) {
      it(`names ${name}`, async () => {
        const sys = fresh();
        setUp(sys);
        const { code, err } = await run(sys);
        assert.deepEqual({ code, err }, { code: 1, err: [...message] });
      });
    }
  });

  describe('test commit', () => {
    it('deletes the branch even when GitHub cannot be asked', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, () => {
        throw new Error('down');
      });
      const { io, out } = capture();
      await assert.rejects(onboard(sys, io, ['example-owner', AGENT]), /down/);
      assert.ok(out.includes('Deleted the throwaway branch process-rules/verify-examplebot-1793361600000.'));
      assert.equal(sys.calls.at(-1)?.command, 'rm');
    });

    it('says so when the branch cannot be deleted', async () => {
      const sys = fresh();
      sys.execOverride = (call) =>
        call.command === 'git' && call.args[3]?.startsWith(':') ? { code: 1, stdout: '', stderr: 'protected\n' } : undefined;
      const { code, err } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(err, ['onboard: could not delete process-rules/verify-examplebot-1793361600000; delete it on GitHub: protected']);
    });

    for (const [args, message] of [
      ['init', 'onboard: git init failed: boom'],
      ['fetch', 'onboard: git fetch failed: boom'],
      ['commit-tree', 'onboard: signing the test commit failed: boom'],
      ['push', 'onboard: pushing as ExampleBot failed: boom'],
    ] as const) {
      it(`reports a failed git ${args} and cleans up`, async () => {
        const sys = fresh();
        sys.execOverride = (call) =>
          call.command === 'git' && call.args[0] === args ? { code: 1, stdout: '', stderr: 'boom\n' } : undefined;
        const { code, err } = await run(sys);
        assert.deepEqual({ code, err }, { code: 1, err: [message] });
        assert.equal(sys.calls.at(-1)?.command, 'rm');
      });
    }

    for (const [name, json, shown] of [
      ['unverified', { committer: { login: AGENT }, commit: { verification: { verified: false, reason: 'unknown_key' } } }, `committer: ${AGENT}; verified: false (unknown_key)`],
      ['committed by someone else', { committer: { login: 'example-owner' }, commit: { verification: { verified: true, reason: 'valid' } } }, 'committer: example-owner; verified: true (valid)'],
      ['unreadable', null, 'committer: none; verified: undefined (no reason)'],
    ] as const) {
      it(`fails a test commit that is ${name}`, async () => {
        const sys = fresh();
        sys.route('GET', `${REPO}/commits/abc123`, { status: 200, json });
        const { code, out, err } = await run(sys);
        assert.equal(code, 1);
        assert.ok(out.includes(`  ${shown}`), out.join('\n'));
        assert.deepEqual(err, ['onboard: GitHub does not show the commit Verified by ExampleBot']);
      });
    }
  });

  for (const [index, step] of ['settings file', 'hook entry', 'workflow', 'test commit'].entries()) {
    it(`stops without changing anything more when "${step}" is declined`, async () => {
      const sys = fresh();
      sys.answers = [...Array<string>(index).fill('y'), 'n'];
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`onboard: stopped at "${step}"; nothing after it was changed`] });
      assert.equal(sys.files.has(WORKFLOW), index > 2);
    });
  }

  for (const [name, setUp, answers] of [
    ['inviting the agent', (sys: FakeSys) => {
      sys.route('GET', REPO, { status: 404, json: null });
      sys.route('GET', '/user/repository_invitations', { status: 200, json: [] });
    }, ['y', 'y', 'n']],
    ['accepting the invitation', (sys: FakeSys) => {
      sys.route('GET', REPO, { status: 404, json: null });
      sys.route('GET', '/user/repository_invitations', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
    }, ['y', 'y', 'n']],
  ] as const) {
    it(`stops when ${name} is declined`, async () => {
      const sys = fresh();
      setUp(sys);
      sys.answers = [...answers];
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: stopped at "agent access"; nothing after it was changed'] });
    });
  }
});

describe('workflow', () => {
  it("calls the product's shared checks on pull requests and the default branch", () => {
    const text = workflow('main');
    assert.match(text, /uses: athya-hq\/process-rules\/\.github\/workflows\/checks\.yml@main/);
    assert.match(text, /branches: \["main"\]/);
    assert.match(text, /permissions:\n {2}contents: read/);
  });
});
