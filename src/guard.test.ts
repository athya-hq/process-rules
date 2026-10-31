import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sessionRecord } from './agent.ts';
import { FakeSys, HOME, capture } from './fake.test.ts';
import { guard, reachesGitHub } from './guard.ts';

const RECORD = sessionRecord(HOME, 'abc-123') as string;

function check(sys: FakeSys, command: unknown, sessionId: unknown = 'abc-123'): { code: number; err: string[] } {
  const { io, out, err } = capture();
  const code = guard(sys, io, JSON.stringify({ session_id: sessionId, tool_input: { command } }));
  assert.deepEqual(out, []);
  return { code, err };
}

const REFUSED = 'process-rules: refused, because this session does not work as the agent on GitHub:';

describe('reachesGitHub', () => {
  for (const command of ['/usr/local/bin/gh pr list', '~/bin/git push', 'git -c a=b fetch', 'git --git-dir=.git push', 'gh pr list', 'cd x && gh api user', 'git push', 'git -C /repo fetch origin', 'git pull --rebase', 'git clone url', 'git ls-remote origin', 'git remote update', 'git submodule update', 'echo; git push -u origin HEAD', '(gh issue view 1)']) {
    it(`finds ${command}`, () => assert.equal(reachesGitHub(command), true));
  }
  for (const command of ['git commit -m "fix push"', 'git log --grep pull', 'ls', 'git status', 'git commit -m fix', 'git log --oneline', 'cat .github/x', 'pnpm check', 'node gh.js', 'ghq list', '/usr/bin/sigh now']) {
    it(`passes ${command}`, () => assert.equal(reachesGitHub(command), false));
  }
});

describe('guard', () => {
  it('lets commands that do not reach GitHub through, with no record', () => {
    assert.deepEqual(check(new FakeSys(), 'git status'), { code: 0, err: [] });
    assert.deepEqual(check(new FakeSys(), undefined), { code: 0, err: [] });
  });

  it('lets GitHub commands through in a session session-start gave the agent identity', () => {
    const sys = new FakeSys();
    sys.files.set(RECORD, '{"agent":"ExampleBot"}\n');
    assert.deepEqual(check(sys, 'git push'), { code: 0, err: [] });
  });

  it('refuses them in a session session-start never ran for', () => {
    assert.deepEqual(check(new FakeSys(), 'gh pr list'), {
      code: 2,
      err: [`${REFUSED} session-start did not run for this session, so it was not given the agent identity. Do not work around it; tell the owner.`],
    });
    assert.equal(check(new FakeSys(), 'gh pr list', '../x').code, 2, 'a session id that is not one');
    assert.equal(check(new FakeSys(), 'gh pr list', 7).code, 2);
  });

  it('refuses them where session-start locked GitHub out, repeating why', () => {
    const sys = new FakeSys();
    sys.files.set(RECORD, JSON.stringify({ problem: 'process-rules: GitHub is locked out of this session: x is missing.' }));
    assert.deepEqual(check(sys, 'git push').err, [
      `${REFUSED} session-start said: process-rules: GitHub is locked out of this session: x is missing. Do not work around it; tell the owner.`,
    ]);
  });

  it('refuses them when the record is not what session-start writes', () => {
    const sys = new FakeSys();
    sys.files.set(RECORD, 'nonsense');
    assert.equal(check(sys, 'git push').err[0], `${REFUSED} ${RECORD} is not what session-start writes. Do not work around it; tell the owner.`);
    sys.files.set(RECORD, '{}');
    assert.equal(check(sys, 'git push').err[0], `${REFUSED} ${RECORD} names no agent. Do not work around it; tell the owner.`);
  });

  it('refuses when given no command to check', () => {
    const { io, err } = capture();
    assert.equal(guard(new FakeSys(), io, ''), 2);
    assert.match(err[0] ?? '', /the hook was given no command to check/);
  });

  it('holds in cloud sessions too', () => {
    const sys = new FakeSys();
    sys.env.CLAUDE_CODE_REMOTE = 'true';
    assert.equal(check(sys, 'git push').code, 2);
  });
});
