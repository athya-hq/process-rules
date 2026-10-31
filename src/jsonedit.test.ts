import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendToArray, replaceValues, setMember } from './jsonedit.ts';

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

  it("writes in the file's own indentation and line endings", () => {
    const four = appendToArray('{\n    "hooks": { "SessionStart": [] }\n}\n', ['hooks'], 'SessionStart', { a: 1 });
    assert.equal(four, '{\n    "hooks": { "SessionStart": [\n        {\n            "a": 1\n        }\n    ] }\n}\n');
    const tabs = appendToArray('{\n\t"env": {}\n}\n', ['hooks'], 'SessionStart', 1);
    assert.equal(tabs, '{\n\t"env": {},\n\t"hooks": {\n\t\t"SessionStart": [\n\t\t\t1\n\t\t]\n\t}\n}\n');
    const crlf = appendToArray('{\r\n  "hooks": {\r\n    "SessionStart": [\r\n      0\r\n    ]\r\n  }\r\n}\r\n', ['hooks'], 'SessionStart', [1]);
    assert.equal(crlf, '{\r\n  "hooks": {\r\n    "SessionStart": [\r\n      0,\r\n      [\r\n        1\r\n      ]\r\n    ]\r\n  }\r\n}\r\n');
    assert.equal(appendToArray('{}\r\n', [], 'k', 1), '{\r\n  "k": [\r\n    1\r\n  ]\r\n}\r\n');
  });

  it('refuses a value of the wrong shape, and reads a repeated key as JSON.parse does', () => {
    assert.throws(() => appendToArray('{ "hooks": "x" }', ['hooks'], 'SessionStart', 1), /^Error: hooks is not an object$/);
    assert.throws(() => appendToArray('{ "hooks": { "SessionStart": {} } }', ['hooks'], 'SessionStart', 1), /^Error: hooks\.SessionStart is not an array$/);
    const repeated = appendToArray('{ "hooks": "x", "hooks": { "SessionStart": [] } }', ['hooks'], 'SessionStart', 1);
    assert.deepEqual(JSON.parse(repeated), { hooks: { SessionStart: [1] } });
  });
});

describe('replaceValues', () => {
  const path = ['hooks', 'SessionStart', '*', 'hooks', '*', 'command'];
  const swap = (value: unknown) => (value === 'old' ? 'new' : undefined);

  it('swaps only the values at the path, where they stand', () => {
    const text = '{\n    "env": { "command": "old" },\n    "hooks": {\n        "Stop": [ { "hooks": [ { "command": "old" } ] } ],\n        "SessionStart": [ { "hooks": [ { "command": "o\\u006cd" }, { "command": "other" }, "old" ] }, null, { "hooks": "old" } ]\n    }\n}\n';
    const { text: out, replaced } = replaceValues(text, path, swap);
    assert.equal(replaced, 1);
    assert.equal(out, text.replace('"o\\u006cd"', '"new"'));
  });

  it('swaps every match, and nothing when the shape is not there', () => {
    const text = '{"hooks":{"SessionStart":[{"hooks":[{"command":"old"}]},{"hooks":[{"command":"old"},{"command":"old"}]}]}}';
    const { text: out, replaced } = replaceValues(text, path, swap);
    assert.equal(replaced, 3);
    assert.equal(out, text.replaceAll('"old"', '"new"'));
    assert.deepEqual(replaceValues('{ "hooks": [] }', path, swap), { text: '{ "hooks": [] }', replaced: 0 });
    assert.deepEqual(replaceValues('[1]', ['*'], () => 2), { text: '[2]', replaced: 1 });
  });
});

describe('setMember', () => {
  it('swaps a value where it stands, keeping the layout', () => {
    const text = '{\r\n    "env": { "A": "1", "B": "2" }\r\n}\r\n';
    assert.equal(setMember(text, ['env'], 'A', 'x'), '{\r\n    "env": { "A": "x", "B": "2" }\r\n}\r\n');
  });

  it('adds a missing key last, in the file\'s layout', () => {
    assert.equal(setMember('{\n    "env": {\n        "A": "1"\n    }\n}\n', ['env'], 'B', '2'), '{\n    "env": {\n        "A": "1",\n        "B": "2"\n    }\n}\n');
  });

  it('creates the objects on the way', () => {
    assert.deepEqual(JSON.parse(setMember('{}', ['env'], 'A', '1')), { env: { A: '1' } });
    assert.deepEqual(JSON.parse(setMember('{ "x": 1 }', ['a', 'b'], 'c', 2)), { x: 1, a: { b: { c: 2 } } });
  });

  it('refuses a value on the way that is not an object, and undefined', () => {
    assert.throws(() => setMember('{ "env": [] }', ['env'], 'A', '1'), /^Error: env is not an object$/);
    assert.throws(() => setMember('{}', ['env'], 'A', undefined), /^Error: env\.A cannot be set to undefined$/);
  });

  it('swaps in an object in the file\'s layout', () => {
    assert.equal(setMember('{\n    "a": {\n        "b": 1\n    }\n}\n', ['a'], 'b', { c: 2 }), '{\n    "a": {\n        "b": {\n            "c": 2\n        }\n    }\n}\n');
  });
});
