import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendToArray } from './jsonedit.ts';

const entry = { hooks: [{ type: 'command', command: 'run "it"' }] };

describe('appendToArray', () => {
  it('adds to an existing array, keeping the rest of the text as it was', () => {
    const text = '{\n  "env": { "A": "1" },\n  "hooks": {\n    "SessionStart": [\n      { "hooks": [] }\n    ],\n    "Stop": []\n  }\n}\n';
    const out = appendToArray(text, ['hooks'], 'SessionStart', entry);
    assert.equal(
      out,
      '{\n  "env": { "A": "1" },\n  "hooks": {\n    "SessionStart": [\n      { "hooks": [] },\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": "run \\"it\\""\n          }\n        ]\n      }\n    ],\n    "Stop": []\n  }\n}\n',
    );
    assert.deepEqual(JSON.parse(out).hooks.SessionStart[1], entry);
  });

  it('fills an empty array', () => {
    const out = appendToArray('{\n  "hooks": {\n    "SessionStart": []\n  }\n}\n', ['hooks'], 'SessionStart', 1);
    assert.equal(out, '{\n  "hooks": {\n    "SessionStart": [\n      1\n    ]\n  }\n}\n');
  });

  it('adds a missing array, and a missing object on the way', () => {
    const noKey = appendToArray('{\n  "hooks": {\n    "Stop": [ "x, y" ]\n  }\n}\n', ['hooks'], 'SessionStart', 1);
    assert.deepEqual(JSON.parse(noKey), { hooks: { Stop: ['x, y'], SessionStart: [1] } });
    assert.match(noKey, /"Stop": \[ "x, y" \],\n {4}"SessionStart": \[\n {6}1\n {4}\]\n {2}\}/);
    const noObject = appendToArray('{\n  "env": {},\n  "n": -1.5e3, "t": true, "z": null\n}\n', ['hooks'], 'SessionStart', 1);
    assert.deepEqual(JSON.parse(noObject), { env: {}, n: -1500, t: true, z: null, hooks: { SessionStart: [1] } });
    assert.deepEqual(JSON.parse(appendToArray('{}', ['hooks'], 'SessionStart', 1)), { hooks: { SessionStart: [1] } });
  });

  it('skips nested values and escaped quotes while it reads', () => {
    const text = '{ "a\\"b": { "hooks": ["}"] }, "hooks": { "SessionStart": [ { "k": "]" } ] } }';
    assert.deepEqual(JSON.parse(appendToArray(text, ['hooks'], 'SessionStart', 2)).hooks.SessionStart, [{ k: ']' }, 2]);
  });
});
