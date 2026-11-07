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

describe('guard on comments that ask the owner', () => {
  const PAGE = 'https://claude.ai/artifact/WrvVo6T7V8fe9pQvYEyvJW';
  const agentSys = (): FakeSys => {
    const sys = new FakeSys();
    sys.files.set(RECORD, '{"agent":"ExampleBot"}\n');
    return sys;
  };
  const run = (sys: FakeSys, command: string, cwd?: string): { code: number; err: string[] } => {
    const { io, out, err } = capture();
    const code = guard(sys, io, JSON.stringify({ session_id: 'abc-123', ...(cwd ? { cwd } : {}), tool_input: { command } }));
    assert.deepEqual(out, []);
    return { code, err };
  };

  it('refuses a long ask that links no page, naming the rule and the fix', () => {
    const long = `Proposal: drop the W-35 lint rule. ${'Here is every detail of why. '.repeat(20)}`;
    const { code, err } = run(agentSys(), `gh issue comment 3206 --body "${long}"`);
    assert.equal(code, 2);
    assert.equal(err.length, 1);
    assert.match(
      err[0] ?? '',
      /^process-rules: refused, because this comment asks the owner \(it opens with "Proposal:"\), and it links no published page .* and runs \d+ characters, over 500\. The rule: anything the owner must read, approve or choose arrives as a published page; .* Fix: publish the page first/,
    );
  });

  it('refuses an ask in a heredoc or a file as it does inline, and @-mentions of the owner', () => {
    const sys = agentSys();
    sys.files.set('/repo/sub/ask.md', 'Needs you: pick one');
    assert.equal(run(sys, "gh pr comment 1 --body \"$(cat <<'EOF'\nNeeds you: pick one\nEOF\n)\"").code, 2);
    assert.equal(run(sys, 'gh issue comment 1 --body-file ask.md', '/repo/sub').code, 2);
    // A cwd that is not a path is not used, so ask.md is looked for in the checkout, where there is none to read.
    assert.match(run(sys, 'gh issue comment 1 --body-file ask.md', 'relative').err[0] ?? '', /cannot see how this comment opens/);
    assert.equal(run(sys, 'gh api repos/o/r/issues/1/comments -f body="@example-owner please look"').code, 2);
  });

  it('lets through a short ask that links a page, and comments that ask nothing', () => {
    const sys = agentSys();
    assert.deepEqual(run(sys, `gh issue comment 3206 --body "Needs you: keep or delete the rule? Page: ${PAGE} Answer: comment on the page."`), { code: 0, err: [] });
    assert.deepEqual(run(sys, `gh pr comment 5 --body "Evidence: ${'all green. '.repeat(80)}"`), { code: 0, err: [] });
    assert.deepEqual(run(sys, 'gh pr comment 5 --body "Merged at $SHA"'), { code: 0, err: [] });
  });

  it('checks the agent identity first', () => {
    assert.match(run(new FakeSys(), 'gh issue comment 1 --body "Needs you: x"').err[0] ?? '', /does not work as the agent/);
  });
});
