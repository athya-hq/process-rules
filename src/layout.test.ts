import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, capture } from './fake.test.ts';
import { painter, runStep, tilde } from './layout.ts';

describe('runStep', () => {
  it('shows a step that throws as failed, with what it said, then lets the error go on', async () => {
    const sys = new FakeSys();
    const { io, out, err } = capture();
    await assert.rejects(
      runStep(sys, io, painter(sys), 'board', async (step) => {
        step.out('made the Project');
        step.err('board: GitHub refused');
        throw new Error('down');
      }),
      /down/,
    );
    assert.deepEqual({ out, err, spinning: sys.spinning }, { out: ['■  board', '│  made the Project'], err: ['board: GitHub refused'], spinning: 0 });
  });
});

describe('tilde', () => {
  it('writes the home folder as ~, and leaves other paths alone', () => {
    assert.deepEqual([tilde('/h', '/h'), tilde('/h', '/h/.ssh/k'), tilde('/h', '/hx/k'), tilde('/h', '/etc')], ['~', '~/.ssh/k', '/hx/k', '/etc']);
  });
});
