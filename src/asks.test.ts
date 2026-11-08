import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';

import { ASK_LIMIT, HOURLY, askProblem, askRefusal, askedBy, commentBodies, commentProblem, needsOwner, opensAsk, opensDecision, ownersAround } from './asks.ts';
import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { UNKNOWN } from './shell.ts';

const OWNER = 'example-owner';
const PAGE = 'https://claude.ai/artifact/WrvVo6T7V8fe9pQvYEyvJW';
const known = (text: string) => ({ text, known: true, opensUnknown: false });

describe('the ask rule', () => {
  it('reads how a comment opens', () => {
    assert.equal(opensAsk('Needs you: approve?'), 'Needs you');
    assert.equal(opensAsk('  **Proposal:** add P-9'), 'Proposal');
    assert.equal(opensAsk('> ## Needs you: x'), 'Needs you');
    assert.equal(opensAsk('Note: Needs you: x'), undefined);
    assert.equal(opensAsk('needs you: x'), undefined);
    assert.equal(opensAsk('no colon here'), undefined);
    assert.equal(opensDecision('Decision: go'), true);
    assert.equal(opensDecision('_Decision:_ go'), true);
    assert.equal(opensDecision('Proposal: go'), false);
  });

  it('counts a comment that names the owner as asking them, with or without an @', () => {
    assert.equal(askedBy('cc @Example-Owner, see above', [OWNER]), 'it names the owner, example-owner');
    assert.equal(askedBy('example-owner said so', [OWNER]), 'it names the owner, example-owner');
    assert.equal(askedBy('example-owners and @example-owner-2 differ', [OWNER]), undefined);
    assert.equal(askedBy('Proposal: x', []), 'it opens with "Proposal:"');
  });

  it('lets through a short ask that links a page, and any comment that does not ask', () => {
    assert.equal(askProblem(known(`Needs you: approve the plan?\nPage: ${PAGE}\nAnswer: label approved.`), [OWNER]), undefined);
    assert.equal(askProblem(known('Proposal: see https://claude.ai/code/artifact/abc-1'), [OWNER]), undefined);
    assert.equal(askProblem(known('Evidence: the run passed.'.repeat(40)), [OWNER]), undefined);
    assert.equal(askProblem({ text: `Evidence for ${UNKNOWN}`, known: false, opensUnknown: false }, [OWNER]), undefined);
  });

  it('refuses an ask with no page link, or over the limit, saying which', () => {
    assert.equal(askProblem(known('Needs you: approve?'), [OWNER]), 'this comment asks the owner (it opens with "Needs you:"), and it links no published page (https://claude.ai/artifact/… or https://claude.ai/code/artifact/…)');
    const long = `Proposal: ${PAGE} ${'x'.repeat(ASK_LIMIT)}`;
    assert.equal(askProblem(known(long), [OWNER]), `this comment asks the owner (it opens with "Proposal:"), and it runs ${[...long].length} characters, over ${ASK_LIMIT}`);
    assert.match(askProblem(known(`@example-owner ${'y'.repeat(ASK_LIMIT)}`), [OWNER]) ?? '', /names the owner, example-owner\), and it links no published page .* and runs 515 characters, over 500$/);
    assert.equal(askProblem(known(`Needs you: ${PAGE} ${'é'.repeat(ASK_LIMIT - 11 - PAGE.length - 1)}`), [OWNER]), undefined, 'characters, not bytes');
  });

  it('refuses a body it cannot measure only where it asks the owner or hides its opening', () => {
    assert.match(askProblem({ text: `Needs you: ${UNKNOWN}`, known: false, opensUnknown: false }, [OWNER]) ?? '', /asks the owner \(it opens with "Needs you:"\), and the guard cannot measure it/);
    assert.match(askProblem({ text: `${UNKNOWN} rest`, known: false, opensUnknown: true }, [OWNER]) ?? '', /cannot see how this comment opens/);
  });

  it('says the rule and the fix when it refuses', () => {
    const line = askRefusal('this comment asks the owner (x), and it links no published page');
    assert.match(line, /^process-rules: refused, because this comment asks the owner \(x\), and it links no published page\. The rule: .* published page; .* 500 characters or fewer\. Fix: publish the page first, then post a comment of at most 500 characters that links it/);
  });
});

const FILES = new Map([
  ['/repo/ask.md', 'Needs you: long\n'],
  ['/repo/input.json', JSON.stringify({ body: 'Proposal: from input' })],
  ['/repo/vars.json', JSON.stringify({ query: 'mutation', variables: { body: 'Needs you: in variables' } })],
  ['/repo/none.json', JSON.stringify({ title: 'x' })],
  ['/repo/bad.json', '{'],
]);
const read = (path: string): string | undefined => FILES.get(path.startsWith('/') ? path : `/repo/${path}`);
const texts = (line: string): string[] => commentBodies(line, read).map((body) => (body.known ? body.text : `?${body.text.replaceAll(UNKNOWN, '?')}`));

describe('commentBodies', () => {
  it('reads the body of gh issue comment and gh pr comment, inline or from a file', () => {
    assert.deepEqual(texts('gh issue comment 12 --body "Needs you: a"'), ['Needs you: a']);
    assert.deepEqual(texts("gh pr comment 3 -b 'b' --repo x/y"), ['b']);
    assert.deepEqual(texts('gh issue comment 1 --body=c'), ['c']);
    assert.deepEqual(texts('gh issue comment 1 -bd'), ['d']);
    assert.deepEqual(texts('gh issue comment 1 --body-file ask.md'), ['Needs you: long\n']);
    assert.deepEqual(texts('gh issue comment 1 -F /repo/ask.md'), ['Needs you: long\n']);
    assert.deepEqual(texts('gh issue comment 1 --body-file=missing.md'), ['?']);
    assert.deepEqual(texts('gh issue comment 1 --body-file "$F"'), ['?']);
    assert.deepEqual(texts("gh issue comment 1 --body-file - <<'EOF'\nProposal: x\nEOF"), ['Proposal: x\n']);
    assert.deepEqual(texts('gh issue comment 1 --body-file -'), ['?']);
    assert.deepEqual(texts('gh pr comment 1 --body'), ['?']);
    assert.deepEqual(texts("cd /repo && /opt/bin/gh pr comment 9 --body \"$(cat <<'EOF'\nNeeds you: heredoc\nEOF\n)\""), ['Needs you: heredoc']);
    assert.deepEqual(texts('gh pr comment -R o/r 9 --body "from -R"'), ['from -R']);
    assert.deepEqual(texts('gh issue comment 1 --body="$X rest"'), ['?? rest'], 'a joined value that opens with a variable');
    assert.equal(commentBodies('gh issue comment 1 -b"$X"', read)[0]?.opensUnknown, true);
    // With no body in the command, gh takes it from an editor, a prompt or the browser.
    assert.deepEqual(texts('gh issue comment 1 --web; gh pr comment 2 --editor; gh issue comment 3 --edit-last'), ['?', '?', '?']);
  });

  it('leaves alone gh commands that post no comment', () => {
    assert.deepEqual(texts('gh issue comment 1 --delete-last --yes'), []);
    assert.deepEqual(texts('gh issue view 1 --comments; gh pr create --body "Needs you: x"; git push'), []);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --paginate --jq .[].body'), []);
    assert.deepEqual(texts('gh api -X POST repos/o/r/issues/1/labels -f labels[]=x'), []);
    assert.deepEqual(texts('gh api graphql -f query="query { viewer { login } }"'), []);
    assert.deepEqual(texts('gh'), []);
  });

  it('reads the body gh api posts to a comments endpoint', () => {
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body="Needs you: a"'), ['Needs you: a']);
    assert.deepEqual(texts('gh api -X PATCH repos/o/r/issues/comments/55 --raw-field body=b'), ['b']);
    assert.deepEqual(texts('gh api repos/o/r/pulls/2/comments/7/replies -F body=@ask.md'), ['Needs you: long\n']);
    assert.deepEqual(texts('gh api --method POST /repos/o/r/issues/1/comments --field=body=c'), ['c']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -Fbody=d -H "Accept: x"'), ['d']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -F body=@-  <<< "Proposal: e"'), ['Proposal: e\n']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body="$B"'), ['??']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f flag -f body=x'), ['x']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input input.json'), ['Proposal: from input']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input none.json'), []);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input bad.json'), ['?']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input "$I"'), ['?']);
  });

  it('reads a GraphQL comment mutation: its body variable, its input, or else its query', () => {
    assert.deepEqual(texts('gh api graphql -f query="mutation(\\$b: String!) { addComment(input: {subjectId: \\"I\\", body: \\$b}) { clientMutationId } }" -f b="Needs you: v"'), ['Needs you: v']);
    assert.deepEqual(texts('gh api graphql -F query=@q.graphql -f body="Proposal: w"'), []);
    assert.deepEqual(texts('gh api graphql -f query="mutation(\\$body: String!) { addComment(input: {body: \\$body}) { x } }" -f body="Proposal: w"'), ['Proposal: w']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I", body: "Proposal: inline\\nline two"}) { clientMutationId } }\''), ['Proposal: inline\nline two']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I", body: "bad \\q"}) { x } }\''), ['?']);
    assert.deepEqual(texts('gh api graphql -f query="mutation { addComment(input: {body: \\"$B\\"}) { x } }"'), ['?']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I"}) { x } }\''), ['mutation { addComment(input: {subjectId: "I"}) { x } }']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { updateIssueComment(input: {}) { x } }\' --input vars.json'), ['Needs you: in variables']);
  });
});

describe('ownersAround', () => {
  it('reads the owners from the nearest settings up from the folder, none outside a client', () => {
    const sys = new FakeSys();
    assert.deepEqual(ownersAround(sys, `${ROOT}/src/deep`), [OWNER]);
    assert.deepEqual(ownersAround(sys, '/elsewhere/x'), []);
    sys.files.set(`${ROOT}/.github/process-rules.json`, '{"owner": 5}');
    assert.deepEqual(ownersAround(sys, ROOT), []);
  });
});

describe('commentProblem', () => {
  it('reads body files where the command runs, and from the home folder', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/sub/ask.md`, 'Needs you: no page');
    sys.files.set(`${sys.home}/ask.md`, `Needs you: ${PAGE}`);
    assert.match(commentProblem(sys, 'gh issue comment 1 --body-file ask.md', `${ROOT}/sub`) ?? '', /links no published page/);
    assert.equal(commentProblem(sys, 'gh issue comment 1 --body-file ~/ask.md', ROOT), undefined);
    assert.equal(commentProblem(sys, `gh issue comment 1 --body-file ${sys.home}/ask.md`, ROOT), undefined);
    assert.equal(commentProblem(sys, 'gh pr list', ROOT), undefined);
    assert.match(commentProblem(sys, 'gh pr comment 1 -b "fine"; gh pr comment 2 -b "cc example-owner"', ROOT) ?? '', /names the owner/);
  });
});

const EVENT = '/run/event.json';
const SLUG = 'example-org/example-app';
const API = 'https://api.github.com';
const LABELS = `${API}/repos/${SLUG}/issues/7/labels`;

function job(name: string, event: unknown, settings?: unknown): FakeSys {
  const sys = new FakeSys();
  sys.env = { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
  sys.files.set(EVENT, JSON.stringify(event));
  if (settings) sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify(settings));
  sys.route('POST', LABELS, { status: 200, json: [] });
  sys.route('DELETE', `${LABELS}/needs-owner`, { status: 200, json: [] });
  return sys;
}

async function runJob(sys: FakeSys): Promise<{ code: number; out: string[] }> {
  const { io, out, err } = capture();
  const code = await needsOwner(sys, io);
  assert.deepEqual(err, []);
  return { code, out };
}

const calls = (sys: FakeSys) => sys.requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.url.replace(API, '')}`);
const comment = (login: string, body: string, labels: string[] = []) => ({ action: 'created', comment: { body, user: { login } }, issue: { number: 7, labels: labels.map((name) => ({ name })) } });

describe('needsOwner', () => {
  it('labels an issue where the agent asks the owner, once', async () => {
    const sys = job('issue_comment', comment(AGENT, `Needs you: approve? ${PAGE}`));
    assert.deepEqual(await runJob(sys), { code: 0, out: ['needs-owner: #7 asks the owner (Needs you:); labelled needs-owner'] });
    assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`]);
    assert.deepEqual(sys.requests[0]?.body, { labels: ['needs-owner'] });
    const again = job('issue_comment', comment(AGENT, 'Proposal: x', ['needs-owner']));
    await runJob(again);
    assert.deepEqual(calls(again), []);
  });

  it("takes the label off at the owner's Decision: comment, and at their approved label", async () => {
    const decided = job('issue_comment', comment(OWNER, 'Decision: go', ['needs-owner']));
    assert.deepEqual((await runJob(decided)).out, ['needs-owner: the owner decided on #7; needs-owner taken off']);
    assert.deepEqual(calls(decided), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    const unlabelled = job('issue_comment', comment(OWNER, 'Decision: go'));
    assert.deepEqual((await runJob(unlabelled)).out, ['needs-owner: the owner decided on #7']);
    assert.deepEqual(calls(unlabelled), []);

    const approved = job('issues', { action: 'labeled', label: { name: 'approved' }, sender: { login: OWNER }, issue: { number: 7, labels: [{ name: 'needs-owner' }, { name: 'approved' }] } });
    assert.deepEqual((await runJob(approved)).out, ['needs-owner: the owner approved #7; needs-owner taken off']);
    assert.deepEqual(calls(approved), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    const bare = job('issues', { action: 'labeled', label: { name: 'approved' }, sender: { login: OWNER }, issue: { number: 7 } });
    assert.deepEqual((await runJob(bare)).out, ['needs-owner: the owner approved #7']);
  });

  describe('a batch answer on the Approvals issue', () => {
    /** Settings naming #7, where the comments of these tests are made, as the Approvals issue. */
    const ON_7 = { owner: OWNER, agent: AGENT, approvals: 7 };
    const NOV_8 = 'Decision: approve #2925 #2924 #2923 #2922 #2742 #2740 #2739 #2814\nNot #2748 yet: I want W-36 to land first.';
    const off = (number: number) => `${API}/repos/${SLUG}/issues/${number}/labels/needs-owner`;

    const hour = (h: number) => `2026-11-08T${String(h).padStart(2, '0')}:00:00Z`;
    const LABELLED = `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`;
    const onIssue = (number: number) => `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`;
    const thumbs = (id: number) => `${API}/repos/${SLUG}/issues/comments/${id}/reactions?content=%2B1&per_page=100&page=1`;
    /** The owner's batch answer as the comment event brings it: made on #7, the Approvals issue, at 05:00. */
    const answer = (body: string, made: Record<string, unknown> = {}) => ({
      action: 'created',
      comment: { id: 700, node_id: 'IC_700', body, user: { login: OWNER }, created_at: hour(5), updated_at: hour(5), ...made },
      issue: { number: 7, labels: [] },
    });
    type Said = { id: number; body: string; user: { login: string }; created_at: string };
    const says = (login: string, id: number, body: string, h: number): Said => ({ id, body, user: { login }, created_at: hour(h) });
    /** Routes issue `number`'s comments, and each one's 👍s: the owner's at `liked[id]`, none elsewhere. */
    const comments = (sys: FakeSys, number: number, list: Said[], liked: Record<number, string> = {}) => {
      sys.route('GET', onIssue(number), { status: 200, json: list });
      for (const { id } of list) sys.route('GET', thumbs(id), { status: 200, json: liked[id] ? [{ user: { login: OWNER }, created_at: liked[id] }] : [] });
    };

    it('judges each labelled issue at once, this answer counted, though the Approvals issue does not list it yet', async () => {
      const sys = job('issue_comment', answer(NOV_8), ON_7);
      sys.route('GET', LABELLED, { status: 200, json: [2925, 2748, 2924, 5].map((number) => ({ number })) });
      // #2925 asked before the answer, which names it; #2748, named only below the first line; #2924 and #5, where no agent asked.
      comments(sys, 2925, [says(AGENT, 1, `Needs you: approve? ${PAGE}`, 1)]);
      comments(sys, 2748, [says(AGENT, 2, `Proposal: add #2748 ${PAGE}`, 1)]);
      comments(sys, 2924, []);
      comments(sys, 5, []);
      comments(sys, 7, []);
      for (const number of [2925, 2924]) sys.route('DELETE', off(number), { status: 200, json: null });
      assert.deepEqual((await runJob(sys)).out, [
        'needs-owner: the owner approved #2925, #2924, #2923, #2922, #2742, #2740, #2739, #2814 on #7, the Approvals issue; judging each issue labelled needs-owner',
        '#2925: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off',
        '#2748: waits on the owner (the proposal for #2748)',
        "#2924: no agent asked there, and the owner's batch answer names it; needs-owner taken off",
        '#5: no agent asked there; left as it is',
        'needs-owner: 4 labelled needs-owner, 2 cleared',
      ]);
      assert.deepEqual(calls(sys), [`DELETE /repos/${SLUG}/issues/2925/labels/needs-owner`, `DELETE /repos/${SLUG}/issues/2924/labels/needs-owner`]);
      assert.equal(sys.requests.filter((request) => request.url === onIssue(7)).length, 1, 'the Approvals issue is read once');
    });

    it('counts the answer once where the Approvals issue lists it, and only from that list when the event names no id', async () => {
      for (const [made, listed, line] of [
        [{ node_id: undefined, updated_at: undefined }, true, '#12: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off'],
        [{ id: undefined }, false, '#12: waits on the owner (the Needs you: ask)'],
      ] as const) {
        const sys = job('issue_comment', answer('Decision: approve #12', made), ON_7);
        sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
        comments(sys, 12, [says(AGENT, 1, `Needs you: go? ${PAGE}`, 1)]);
        comments(sys, 7, listed ? [says(OWNER, 700, 'Decision: approve #12', 5)] : []);
        sys.route('DELETE', off(12), { status: 200, json: null });
        assert.equal((await runJob(sys)).out[1], line);
      }
    });

    describe('one proposal at a time (#203)', () => {
      const ADD = `Proposal: add #12 (Late slice) to work item #5, after its approval. ${PAGE}`;
      const DROP = `Proposal: drop state #30 (Dropped state), closed as not planned after work item #5's approval. ${PAGE}`;
      const add = (h: number) => says(AGENT, 120, ADD, h);
      const drop = (h: number) => says(AGENT, 121, DROP, h);

      /** What the sweep, then the comment event on Approvals, say of slice #12 with these comments and the owner's batch answer `batch`, made at 05:00. */
      const both = async (list: Said[], batch: string, liked: Record<number, string> = {}, timeline?: unknown[]): Promise<string[]> => {
        const lines: string[] = [];
        for (const name of ['schedule', 'issue_comment']) {
          const sys = job(name, name === 'schedule' ? {} : answer(batch), ON_7);
          sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
          comments(sys, 12, list, liked);
          if (timeline) sys.route('GET', `${API}/repos/${SLUG}/issues/12/timeline?per_page=100&page=1`, { status: 200, json: timeline });
          comments(sys, 7, name === 'schedule' ? [says(OWNER, 700, batch, 5)] : []);
          sys.route('DELETE', off(12), { status: 200, json: null });
          lines.push(...(await runJob(sys)).out.filter((line) => line.startsWith('#12: ')));
        }
        return lines;
      };
      const twice = (line: string) => [line, line];
      const BATCHED = '#12: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off';

      it("1. clears a slice owing only a State's drop when the batch names the State, and not when it names the slice", async () => {
        assert.deepEqual(await both([drop(1)], 'Decision: approve #30'), twice(BATCHED));
        assert.deepEqual(await both([drop(1)], 'Decision: approve #12'), twice('#12: waits on the owner (the proposal for #30)'));
      });

      it('2. keeps a slice whose other proposal waits when the batch names one, and clears it when it names both', async () => {
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #12'), twice('#12: waits on the owner (the proposal for #30)'));
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #30'), twice('#12: waits on the owner (the proposal for #12)'));
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #12 #30'), twice(BATCHED));
      });

      it('3. keeps a slice where the owner 👍d the latest proposal and an earlier one waits, and clears it when each is answered', async () => {
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #99', { 121: hour(3) }), twice('#12: waits on the owner (the proposal for #12)'));
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #99', { 120: hour(3), 121: hour(3) }), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
        assert.deepEqual(
          await both([add(1), drop(2)], 'Decision: approve #12', { 121: hour(3) }),
          twice('#12: the owner answered with a 👍 on the ask and a "Decision: approve" on #7, the Approvals issue; needs-owner taken off'),
        );
      });

      it('counts a Decision: on the slice only for the proposals before it', async () => {
        assert.deepEqual(await both([add(1), says(OWNER, 122, 'Decision: yes', 2), drop(3)], 'Decision: approve #99'), twice('#12: waits on the owner (the proposal for #30)'));
        assert.deepEqual(await both([add(1), drop(2), says(OWNER, 122, 'Decision: yes', 3)], 'Decision: approve #99'), twice('#12: the owner answered with a Decision: comment; needs-owner taken off'));
      });

      it('judges a Needs you: ask as before: the latest ask, when it is one', async () => {
        const ask = (h: number) => says(AGENT, 123, `Needs you: go? ${PAGE}`, h);
        // A Needs you: before a later proposal is not owed; the latest one is, for the slice itself.
        assert.deepEqual(await both([ask(1), drop(2)], 'Decision: approve #30'), twice(BATCHED));
        assert.deepEqual(await both([drop(1), ask(2)], 'Decision: approve #30'), twice('#12: waits on the owner (the Needs you: ask)'));
        assert.deepEqual(await both([drop(1), ask(2)], 'Decision: approve #30 #12'), twice(BATCHED));
      });

      it("counts an answer to a slice's addition only after the slice was last added (#207)", async () => {
        const readded = (h: number) => [{ event: 'parent_issue_added', created_at: hour(0) }, { event: 'commented' }, { event: 'parent_issue_added', created_at: hour(h) }];
        // Taken out and added again at 04:00, after the proposal at 01:00: a 👍 or a Decision: before that answers nothing.
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(3) }, readded(4)), twice('#12: waits on the owner (the proposal for #12)'));
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(6) }, readded(4)), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
        assert.deepEqual(await both([add(1), says(OWNER, 122, 'Decision: yes', 3)], 'Decision: approve #99', {}, readded(4)), twice('#12: waits on the owner (the proposal for #12)'));
        assert.deepEqual(await both([add(1), says(OWNER, 122, 'Decision: yes', 6)], 'Decision: approve #99', {}, readded(4)), twice('#12: the owner answered with a Decision: comment; needs-owner taken off'));
        // The batch answer at 05:00 counts after an addition at 04:00, not after one at 06:00.
        assert.deepEqual(await both([add(1)], 'Decision: approve #12', {}, readded(4)), twice(BATCHED));
        assert.deepEqual(await both([add(1)], 'Decision: approve #12', {}, readded(6)), twice('#12: waits on the owner (the proposal for #12)'));
        // A State's drop is not the slice's addition, and an addition before the proposal changes nothing.
        assert.deepEqual(
          await both([add(1), drop(2)], 'Decision: approve #12', { 121: hour(3) }, readded(4)),
          twice('#12: the owner answered with a 👍 on the ask and a "Decision: approve" on #7, the Approvals issue; needs-owner taken off'),
        );
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(3) }, [{ event: 'parent_issue_added', created_at: hour(0) }]), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
      });
    });

    it('is an ordinary decision on any other issue, from anyone but an owner, or without "approve"', async () => {
      const elsewhere = job('issue_comment', comment(OWNER, NOV_8, ['needs-owner']));
      assert.deepEqual((await runJob(elsewhere)).out, ['needs-owner: the owner decided on #7; needs-owner taken off']);
      assert.deepEqual(calls(elsewhere), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
      const plain = job('issue_comment', comment(OWNER, 'Decision: go', ['needs-owner']), ON_7);
      assert.deepEqual((await runJob(plain)).out, ['needs-owner: the owner decided on #7; needs-owner taken off']);
      for (const event of [comment(AGENT, NOV_8), { ...comment(OWNER, NOV_8), action: 'edited' }]) {
        const sys = job('issue_comment', event, ON_7);
        assert.deepEqual((await runJob(sys)).out, ['needs-owner: the comment on #7 neither asks the owner nor is their decision; nothing to do']);
        assert.deepEqual(calls(sys), []);
      }
    });

    it("sweeps: off where an owner's batch answer after the latest ask names it on the first line; read once", async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT, approvals: 70 });
      const at = (hour: number) => `2026-11-08T${String(hour).padStart(2, '0')}:00:00Z`;
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [1, 2, 3, 4].map((number) => ({ number })) });
      for (const number of [1, 2, 3, 4]) {
        sys.route('GET', `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`, { status: 200, json: [{ id: number * 10, body: `Proposal: ${number}`, user: { login: AGENT }, created_at: at(1) }] });
        sys.route('GET', `${API}/repos/${SLUG}/issues/comments/${number * 10}/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
      }
      const approvals = `${API}/repos/${SLUG}/issues/70/comments?per_page=100&page=1`;
      sys.route('GET', approvals, {
        status: 200,
        json: [
          // #1 approved after its ask; #3 named only below the first line.
          { id: 700, body: 'Decision: approve #1\nNot #3 yet.', user: { login: OWNER }, created_at: at(3) },
          // #2 approved before its latest ask.
          { id: 701, body: 'Decision: approve #2', user: { login: OWNER }, created_at: at(0) },
          // #4 approved in a comment the agent edited.
          { id: 702, node_id: 'IC_702', body: 'Decision: approve #4', user: { login: OWNER }, created_at: at(3), updated_at: at(4) },
        ],
      });
      sys.route('POST', `${API}/graphql`, { status: 200, json: { data: { nodes: [{ id: 'IC_702', userContentEdits: { totalCount: 2, nodes: [{ editor: { login: AGENT } }, { editor: { login: OWNER } }] } }] } } });
      sys.route('DELETE', `${API}/repos/${SLUG}/issues/1/labels/needs-owner`, { status: 200, json: null });
      assert.deepEqual((await runJob(sys)).out, [
        '#1: the owner answered with a "Decision: approve" on #70, the Approvals issue; needs-owner taken off',
        '#2: waits on the owner (the proposal for #2)',
        '#3: waits on the owner (the proposal for #3)',
        '#4: waits on the owner (the proposal for #4)',
        'needs-owner: 4 labelled needs-owner, 1 cleared',
      ]);
      assert.deepEqual(calls(sys), [`DELETE /repos/${SLUG}/issues/1/labels/needs-owner`, 'POST /graphql']);
      assert.equal(sys.requests.filter((request) => request.url === approvals).length, 1);
    });

    it("sweeps: an owner's 👍 on the ask clears it without reading the Approvals issue", async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT, approvals: 70 });
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [{ number: 1 }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/1/comments?per_page=100&page=1`, { status: 200, json: [{ id: 10, body: 'Proposal: 1', user: { login: AGENT }, created_at: '2026-11-08T01:00:00Z' }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/comments/10/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [{ user: { login: OWNER }, created_at: '2026-11-08T02:00:00Z' }] });
      sys.route('DELETE', `${API}/repos/${SLUG}/issues/1/labels/needs-owner`, { status: 200, json: null });
      assert.deepEqual((await runJob(sys)).out, ['#1: the owner answered with a 👍 on the ask; needs-owner taken off', 'needs-owner: 1 labelled needs-owner, 1 cleared']);
      assert.equal(sys.requests.some((request) => request.url.includes('/issues/70/')), false);
    });

    it('sweeps on where GitHub cannot find the Approvals issue', async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT, approvals: 71 });
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [{ number: 1 }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/1/comments?per_page=100&page=1`, { status: 200, json: [{ id: 10, body: 'Proposal: 1', user: { login: AGENT }, created_at: '2026-11-08T01:00:00Z' }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/comments/10/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/71/comments?per_page=100&page=1`, { status: 404, json: { message: 'Not Found' } });
      assert.deepEqual((await runJob(sys)).out, ['#1: waits on the owner (the proposal for #1)', 'needs-owner: 1 labelled needs-owner, 0 cleared']);
    });
  });

  it('labels a pull request where the agent asks in a review comment, and clears it at a decision there', async () => {
    const asked = job('pull_request_review_comment', { action: 'created', comment: { body: `Proposal: x ${PAGE}`, user: { login: AGENT } }, pull_request: { number: 7, labels: [] } });
    assert.deepEqual((await runJob(asked)).out, ['needs-owner: #7 asks the owner (Proposal:); labelled needs-owner']);
    assert.deepEqual(calls(asked), [`POST /repos/${SLUG}/issues/7/labels`]);
    const decided = job('pull_request_review_comment', { action: 'created', comment: { body: 'Decision: yes', user: { login: OWNER } }, pull_request: { number: 7, labels: [{ name: 'needs-owner' }] } });
    await runJob(decided);
    assert.deepEqual(calls(decided), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    assert.deepEqual((await runJob(job('pull_request', { action: 'opened', pull_request: { number: 7 } }))).out, ['needs-owner: nothing to do on a pull_request event']);
  });

  it('names the hourly cron in the shared workflow as the code does', () => {
    const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
    assert.equal(checks.split(`github.event.schedule != '${HOURLY}'`).length, 2, 'the decisions job skips it');
    assert.equal(checks.split(`github.event.schedule == '${HOURLY}'`).length, 2, 'the needs-owner job runs on it');
    assert.match(checks, /pull_request_review_comment/);
  });

  it('leaves the label where someone else answers, or the comment is not an ask', async () => {
    for (const event of [
      comment(AGENT, 'Decision: mine'),
      comment(OWNER, 'Needs you: myself'),
      comment('someone', 'Proposal: x'),
      { ...comment(AGENT, 'Proposal: x'), action: 'edited' },
      { ...comment(OWNER, 'Decision: x'), action: 'deleted' },
      { action: 'created', issue: { number: 7 } },
    ]) {
      const sys = job('issue_comment', event);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: the comment on #7 neither asks the owner nor is their decision; nothing to do']);
      assert.deepEqual(calls(sys), []);
    }
    for (const event of [
      { action: 'labeled', label: { name: 'approved' }, sender: { login: AGENT }, issue: { number: 7 } },
      { action: 'labeled', label: { name: 'bug' }, sender: { login: OWNER }, issue: { number: 7 } },
      { action: 'unlabeled', label: { name: 'approved' }, sender: { login: OWNER }, issue: { number: 7 } },
      { action: 'labeled', issue: { number: 7 } },
    ]) {
      const sys = job('issues', event);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 was not approved by the owner; nothing to do']);
      assert.deepEqual(calls(sys), []);
    }
    assert.deepEqual((await runJob(job('push', {}))).out, ['needs-owner: nothing to do on a push event']);
    assert.deepEqual((await runJob(job('issues', {}))).out, ['needs-owner: nothing to do on a issues event']);
  });

  it('sweeps: off where the owner 👍d the latest ask after its last edit or decided after it; on elsewhere', async () => {
    const sys = job('schedule', {});
    const issues = (number: number) => `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`;
    const reactions = (id: number) => `${API}/repos/${SLUG}/issues/comments/${id}/reactions?content=%2B1&per_page=100&page=1`;
    sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [1, 2, 3, 4, 5, 6].map((number) => ({ number })) });
    const at = (hour: number) => `2026-11-07T${String(hour).padStart(2, '0')}:00:00Z`;
    const ask = (id: number, hour: number, edited?: number) => ({ id, body: `Needs you: ${id}`, user: { login: AGENT }, created_at: at(hour), updated_at: at(edited ?? hour) });
    // #1: 👍 on the latest ask.
    sys.route('GET', issues(1), { status: 200, json: [ask(10, 1), ask(11, 2)] });
    sys.route('GET', reactions(11), { status: 200, json: [{ user: { login: OWNER }, created_at: at(3) }] });
    // #2: 👍 only on an older ask, and by someone else on the latest.
    sys.route('GET', issues(2), { status: 200, json: [ask(20, 1), ask(21, 4)] });
    sys.route('GET', reactions(21), { status: 200, json: [{ user: { login: 'someone' }, created_at: at(5) }] });
    // #3: the ask was edited after the 👍.
    sys.route('GET', issues(3), { status: 200, json: [ask(30, 1, 6)] });
    sys.route('GET', reactions(30), { status: 200, json: [{ user: { login: OWNER }, created_at: at(2) }] });
    // #4: the owner decided after the ask.
    sys.route('GET', issues(4), { status: 200, json: [ask(40, 1), { id: 41, body: 'Decision: no', user: { login: OWNER }, created_at: at(2) }] });
    // #5: no agent asked there, as on an undo issue.
    sys.route('GET', issues(5), { status: 200, json: [{ id: 50, body: 'Proposal: by hand', user: { login: OWNER }, created_at: at(1) }, { id: 51, body: null, user: null, created_at: at(2) }] });
    // #6: a decision before the latest ask does not answer it.
    sys.route('GET', issues(6), { status: 200, json: [{ id: 60, body: 'Decision: old', user: { login: OWNER }, created_at: at(1) }, { ...ask(61, 2), updated_at: undefined }] });
    sys.route('GET', reactions(61), { status: 200, json: [] });
    for (const number of [1, 4]) sys.route('DELETE', `${API}/repos/${SLUG}/issues/${number}/labels/needs-owner`, { status: 404, json: null });
    assert.deepEqual((await runJob(sys)).out, [
      '#1: the owner answered with a 👍 on the ask; needs-owner taken off',
      '#2: waits on the owner (the Needs you: ask)',
      '#3: waits on the owner (the Needs you: ask)',
      '#4: the owner answered with a Decision: comment; needs-owner taken off',
      '#5: no agent asked there; left as it is',
      '#6: waits on the owner (the Needs you: ask)',
      'needs-owner: 6 labelled needs-owner, 2 cleared',
    ]);
    assert.deepEqual(calls(sys), [`DELETE /repos/${SLUG}/issues/1/labels/needs-owner`, `DELETE /repos/${SLUG}/issues/4/labels/needs-owner`]);
  });

  it('sweeps: a Decision: someone other than an owner edited answers nothing; one owners alone edited does', async () => {
    const sys = job('schedule', {});
    const issues = (number: number) => `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`;
    sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [1, 2].map((number) => ({ number })) });
    const ask = (id: number) => ({ id, body: `Needs you: ${id}`, user: { login: AGENT }, created_at: '2026-11-07T01:00:00Z' });
    const decision = (id: number) => ({ id, node_id: `IC_${id}`, body: 'Decision: yes', user: { login: OWNER }, created_at: '2026-11-07T02:00:00Z', updated_at: '2026-11-07T03:00:00Z' });
    // #1: the agent edited the owner's decision; #2: only the owner did.
    sys.route('GET', issues(1), { status: 200, json: [ask(10), decision(11)] });
    sys.route('GET', `${API}/repos/${SLUG}/issues/comments/10/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
    sys.route('GET', issues(2), { status: 200, json: [ask(20), decision(21)] });
    const edits: Record<string, string[]> = { IC_11: [AGENT, OWNER], IC_21: [OWNER, OWNER] };
    sys.route('POST', `${API}/graphql`, () => {
      const { ids } = (sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables;
      const nodes = ids.map((id) => ({ id, userContentEdits: { totalCount: 2, nodes: (edits[id] ?? []).map((login) => ({ editor: { login } })) } }));
      return { status: 200, json: { data: { nodes } } };
    });
    sys.route('DELETE', `${API}/repos/${SLUG}/issues/2/labels/needs-owner`, { status: 200, json: null });
    assert.deepEqual((await runJob(sys)).out, [
      '#1: waits on the owner (the Needs you: ask)',
      '#2: the owner answered with a Decision: comment; needs-owner taken off',
      'needs-owner: 2 labelled needs-owner, 1 cleared',
    ]);
    // One edit read for each issue's edited decision; the label comes off #2 alone.
    assert.deepEqual(calls(sys), ['POST /graphql', 'POST /graphql', `DELETE /repos/${SLUG}/issues/2/labels/needs-owner`]);
  });

  it('sweeps on a run by hand too, reading every page', async () => {
    const sys = job('workflow_dispatch', {});
    const list = `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100`;
    sys.route('GET', `${list}&page=1`, { status: 200, json: Array.from({ length: 100 }, () => ({ number: 9 })) });
    sys.route('GET', `${list}&page=2`, { status: 200, json: [] });
    sys.route('GET', `${API}/repos/${SLUG}/issues/9/comments?per_page=100&page=1`, { status: 200, json: [] });
    assert.equal((await runJob(sys)).out.at(-1), 'needs-owner: 100 labelled needs-owner, 0 cleared');
  });

  it('fails when GitHub refuses a read or a label', async () => {
    const list = job('schedule', {});
    list.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 403, json: null });
    await assert.rejects(needsOwner(list, capture().io), /cannot read \/repos\/example-org\/example-app\/issues\?state=open&labels=needs-owner \(HTTP 403\)/);
    const add = job('issue_comment', comment(AGENT, 'Proposal: x'));
    add.route('POST', LABELS, { status: 403, json: null });
    await assert.rejects(needsOwner(add, capture().io), /cannot label #7 needs-owner \(HTTP 403\)/);
    const remove = job('issue_comment', comment(OWNER, 'Decision: x', ['needs-owner']));
    remove.route('DELETE', `${LABELS}/needs-owner`, { status: 500, json: null });
    await assert.rejects(needsOwner(remove, capture().io), /cannot take needs-owner off #7 \(HTTP 500\)/);
  });

  it('runs only in Actions, in an adopted repository with the board on', async () => {
    const sys = job('schedule', {});
    sys.env = {};
    await assert.rejects(needsOwner(sys, capture().io), /needs-owner runs in GitHub Actions/);
    const bare = job('schedule', {});
    bare.files.delete(`${ROOT}/.github/process-rules.json`);
    assert.deepEqual((await runJob(bare)).out, ['needs-owner: the base branch has no .github/process-rules.json, so the repo is not adopted on its base yet; nothing to check']);
    const off = job('schedule', {}, { owner: OWNER, agent: AGENT, features: ['identity', 'work-rules'] });
    assert.deepEqual((await runJob(off)).out, ['needs-owner: board is off in .github/process-rules.json; nothing to check']);
  });
});
