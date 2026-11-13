import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { main, problems } from './released-pins.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'released-pins-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const PROJECT = (deps, packages) =>
  [
    'lockfileVersion: "9.0"',
    'importers:',
    '  .:',
    '    devDependencies:',
    ...Object.entries(deps).flatMap(([name, { specifier, version }]) => [`      "${name}":`, `        specifier: "${specifier}"`, `        version: "${version}"`]),
    'packages:',
    ...Object.entries(packages).flatMap(([key, resolution]) => [`  "${key}":`, `    resolution: ${JSON.stringify(resolution)}`]),
  ].join('\n');

/** pnpm 12's lockfile: the package manager's own lock first, then the project's. */
const LOCK = (deps, packages) =>
  ['---', 'lockfileVersion: "9.0"', 'importers:', '  .:', '    configDependencies: {}', '', '---', PROJECT(deps, packages), ''].join('\n');

let count = 0;
/**
 * A repository pinning `pins`, locked as `lock` gives (each pin from the registry when absent), with
 * each package in `installed` laid out in node_modules/.pnpm at the version given, or not at all.
 */
function repo({ pins, lock, installed = {}, noLock = false, link }) {
  const root = join(scratch, `repo-${++count}`);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: pins }));
  const registry = Object.fromEntries(Object.entries(pins).map(([name, pin]) => [name, { specifier: pin, version: pin }]));
  const packages = Object.fromEntries(Object.entries(pins).map(([name, pin]) => [`${name}@${pin}`, { integrity: 'sha512-abc' }]));
  if (!noLock) writeFileSync(join(root, 'pnpm-lock.yaml'), LOCK(lock?.deps ?? registry, lock?.packages ?? packages));
  for (const [name, version] of Object.entries(installed)) {
    const store = join(root, 'node_modules', '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'package.json'), JSON.stringify({ name, version }));
    mkdirSync(join(root, 'node_modules', '@veda-hq'), { recursive: true });
    symlinkSync(store, join(root, 'node_modules', name));
  }
  if (link) {
    const source = join(root, 'packages', 'dvara');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: link, version: pins[link] }));
    mkdirSync(join(root, 'node_modules', '@veda-hq'), { recursive: true });
    symlinkSync(source, join(root, 'node_modules', link));
  }
  return root;
}

const DVARA = '@veda-hq/dvara';

describe('problems', () => {
  test('passes an exact pin, locked from the registry and installed at its version', () => {
    assert.deepEqual(problems(repo({ pins: { [DVARA]: '0.5.16', typescript: '^7' }, installed: { [DVARA]: '0.5.16' } })), []);
  });

  test('checks only the packages named, each of which must be pinned', () => {
    const root = repo({ pins: { [DVARA]: '0.5.16', '@veda-hq/pariksha': '^0.5' }, installed: { [DVARA]: '0.5.16' } });
    assert.deepEqual(problems(root, [DVARA]), []);
    assert.deepEqual(problems(root, ['@veda-hq/sarathi']), ['@veda-hq/sarathi is not a devDependency of package.json']);
  });

  test('refuses a range', () => {
    assert.deepEqual(problems(repo({ pins: { [DVARA]: '^0.5.16' } })), [`${DVARA} is pinned as "^0.5.16", not as an exact released version`]);
  });

  test('refuses without a lockfile', () => {
    const root = repo({ pins: { [DVARA]: '0.5.16' }, noLock: true });
    assert.deepEqual(problems(root), [`there is no pnpm-lock.yaml in ${root}; run pnpm install`]);
  });

  test('refuses a pin the lockfile does not hold, or holds at another specifier', () => {
    const pins = { [DVARA]: '0.5.16' };
    assert.match(problems(repo({ pins, lock: { deps: {}, packages: {} } }))[0], /is not in pnpm-lock.yaml/);
    assert.match(problems(repo({ pins, lock: { deps: { [DVARA]: { specifier: '0.5.15', version: '0.5.15' } }, packages: {} } }))[0], /locks @veda-hq\/dvara as "0.5.15", but package.json pins 0.5.16/);
  });

  test('refuses a link, a file, a workspace package, or another version in the lockfile', () => {
    const pins = { [DVARA]: '0.5.16' };
    for (const version of ['link:../veda/packages/dvara', 'file:../dvara.tgz', 'workspace:*']) {
      const root = repo({ pins, lock: { deps: { [DVARA]: { specifier: '0.5.16', version } }, packages: {} } });
      assert.deepEqual(problems(root), [`pnpm-lock.yaml resolves ${DVARA} to ${version}, not the registry release 0.5.16`]);
    }
    const other = repo({ pins, lock: { deps: { [DVARA]: { specifier: '0.5.16', version: '0.5.17' } }, packages: {} } });
    assert.deepEqual(problems(other), [`pnpm-lock.yaml resolves ${DVARA} to 0.5.17, not 0.5.16`]);
  });

  test('accepts a version with peer suffixes', () => {
    const lock = { deps: { [DVARA]: { specifier: '0.5.16', version: '0.5.16(typescript@7.0.2)' } }, packages: { [`${DVARA}@0.5.16`]: { integrity: 'sha512-abc' } } };
    assert.deepEqual(problems(repo({ pins: { [DVARA]: '0.5.16' }, lock, installed: { [DVARA]: '0.5.16' } })), []);
  });

  test('refuses an entry with no integrity hash, or one from a tarball URL, a directory or a git repository', () => {
    const pins = { [DVARA]: '0.5.16' };
    const deps = { [DVARA]: { specifier: '0.5.16', version: '0.5.16' } };
    const key = `${DVARA}@0.5.16`;
    assert.match(problems(repo({ pins, lock: { deps, packages: {} } }))[0], /no integrity hash for @veda-hq\/dvara@0.5.16/);
    assert.match(problems(repo({ pins, lock: { deps, packages: { [key]: { integrity: '' } } } }))[0], /no integrity hash/);
    for (const [field, where] of [['tarball', 'https://example.invalid/dvara.tgz'], ['directory', '../dvara'], ['repo', 'https://example.invalid/veda.git']]) {
      const root = repo({ pins, lock: { deps, packages: { [key]: { integrity: 'sha512-abc', [field]: where } } } });
      assert.deepEqual(problems(root), [`pnpm-lock.yaml takes ${key} from ${where}, not the registry`]);
    }
  });

  test('refuses a pin that is not installed, or installed at another version', () => {
    const root = repo({ pins: { [DVARA]: '0.5.16' } });
    assert.deepEqual(problems(root), [`${DVARA} 0.5.16 is not installed in ${root}; run pnpm install there`]);
    const other = repo({ pins: { [DVARA]: '0.5.16' }, installed: { [DVARA]: '0.5.15' } });
    assert.deepEqual(problems(other), [`${DVARA} 0.5.15 is installed, but package.json pins 0.5.16; run pnpm install in ${other}`]);
  });

  test('refuses a package linked from a folder of the checkout', () => {
    const root = repo({ pins: { [DVARA]: '0.5.16' }, link: DVARA });
    assert.deepEqual(problems(root), [`${DVARA} resolves to packages/dvara, a folder of this checkout, not the released 0.5.16`]);
  });

  test('reads a lockfile of one document', () => {
    const root = repo({ pins: { [DVARA]: '0.5.16' }, installed: { [DVARA]: '0.5.16' } });
    writeFileSync(join(root, 'pnpm-lock.yaml'), PROJECT({ [DVARA]: { specifier: '0.5.16', version: '0.5.16' } }, { [`${DVARA}@0.5.16`]: { integrity: 'sha512-abc' } }));
    assert.deepEqual(problems(root), []);
  });

  test('reads a package.json with no devDependencies, and a lockfile with no project, as holding no pin', () => {
    const root = join(scratch, 'bare');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{}');
    assert.deepEqual(problems(root), []);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { [DVARA]: '0.5.16' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    assert.match(problems(root)[0], /is not in pnpm-lock.yaml/);
  });
});

describe('main', () => {
  test('exits 0 when every pin holds, 1 with each problem on stderr, 2 on a usage error', (t) => {
    const errors = [];
    t.mock.method(console, 'error', (line) => errors.push(line));
    const good = repo({ pins: { [DVARA]: '0.5.16' }, installed: { [DVARA]: '0.5.16' } });
    assert.equal(main(['--root', good]), 0);
    assert.equal(main(['--root', good, DVARA]), 0);
    assert.equal(main(['--root', repo({ pins: { [DVARA]: '0.5' } })]), 1);
    assert.match(errors.at(-1), /^released-pins: @veda-hq\/dvara is pinned as "0.5"/);
    assert.equal(main(['--root']), 2);
    assert.match(errors.at(-1), /^usage: released-pins.mjs/);
  });

  test('reads the current directory by default', (t) => {
    t.mock.method(process, 'cwd', () => repo({ pins: { [DVARA]: '0.5.16' }, installed: { [DVARA]: '0.5.16' } }));
    assert.equal(main([]), 0);
  });
});
