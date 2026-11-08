import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { approvedIn, batchAnswers } from './approvals.ts';

/** The spec's example, from the batch of 2026-11-08: eight approved, #2748 left waiting. */
const NOV_8 = 'Decision: approve #2925 #2924 #2923 #2922 #2742 #2740 #2739 #2814\nNot #2748 yet: I want W-36 to land first.';

describe('approvedIn', () => {
  it('reads every issue on the first line, and none below it', () => {
    assert.deepEqual(approvedIn(NOV_8), [2925, 2924, 2923, 2922, 2742, 2740, 2739, 2814]);
    assert.deepEqual(approvedIn('  decision:   APPROVE #7, #8 and #7 again\r\n#9'), [7, 8]);
  });

  it('approves nothing unless the first line opens "Decision: approve"', () => {
    for (const body of ['Decision: #7 is fine', 'Decision: approved #7', 'I approve #7', 'Proposal: approve #7', '\nDecision: approve #7', '', 'Decision: approve']) {
      assert.deepEqual(approvedIn(body), [], body);
    }
  });

  it("reads this repository's issues alone, not another's or a longer number", () => {
    assert.deepEqual(approvedIn('Decision: approve other/repo#7 x#8 #9a #10 (#11)'), [10, 11]);
  });
});

describe('batchAnswers', () => {
  const owners = ['example-owner'];
  const at = (hour: number): string => `2026-11-08T${String(hour).padStart(2, '0')}:00:00Z`;

  it("keeps the owners' answers approving the issue, made after the ask", () => {
    const mine = { body: NOV_8, user: { login: 'Example-Owner' }, created_at: at(3) };
    const comments = [
      mine,
      { body: NOV_8, user: { login: 'ExampleBot' }, created_at: at(3) },
      { body: NOV_8, user: { login: 'example-owner' }, created_at: at(1) },
      { body: NOV_8, user: null, created_at: at(3) },
      { body: null, user: { login: 'example-owner' }, created_at: at(3) },
    ];
    assert.deepEqual(batchAnswers(comments, owners, 2925, at(2)), [mine]);
    assert.deepEqual(batchAnswers(comments, owners, 2748, at(2)), []);
  });
});
