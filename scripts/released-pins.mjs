#!/usr/bin/env node
// niyam is guarded by released Veda packages, never by a copy being changed
// (0114 spec, rule T-9). Each @veda-hq/* devDependency in package.json is an
// exact version, which pnpm-lock.yaml resolves from the registry with an
// integrity hash, and which node_modules holds, at that version and not
// linked from anywhere inside this checkout.
//
//   released-pins.mjs [--root <dir>] [package…]
//
// With no package, checks every @veda-hq/* devDependency; with some, only
// those, each of which must be pinned. Exit 0: all in place; 1: one is not,
// with what to do; 2: a usage error.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseAllDocuments } from 'yaml';

const EXACT = /^\d+\.\d+\.\d+$/;

/** @param {string} file @returns {any} */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * What the lockfile says of a pin, empty when it is a registry release.
 * @param {any} lock the parsed pnpm-lock.yaml
 * @param {string} name
 * @param {string} pin
 * @returns {string | undefined}
 */
function lockProblem(lock, name, pin) {
  const entry = lock?.importers?.['.']?.devDependencies?.[name];
  if (entry === undefined) return `${name} is not in pnpm-lock.yaml; run pnpm install`;
  if (entry.specifier !== pin) return `pnpm-lock.yaml locks ${name} as "${entry.specifier}", but package.json pins ${pin}; run pnpm install`;
  const version = String(entry.version);
  if (/^(link|file|workspace|portal):/.test(version)) return `pnpm-lock.yaml resolves ${name} to ${version}, not the registry release ${pin}`;
  if (version !== pin && !version.startsWith(`${pin}(`)) return `pnpm-lock.yaml resolves ${name} to ${version}, not ${pin}`;
  const resolution = lock?.packages?.[`${name}@${pin}`]?.resolution;
  if (typeof resolution?.integrity !== 'string' || resolution.integrity === '') return `pnpm-lock.yaml has no integrity hash for ${name}@${pin}, so it is not a registry tarball`;
  if (resolution.tarball !== undefined || resolution.directory !== undefined || resolution.repo !== undefined) {
    return `pnpm-lock.yaml takes ${name}@${pin} from ${resolution.tarball ?? resolution.directory ?? resolution.repo}, not the registry`;
  }
  return undefined;
}

/**
 * What is wrong with each pin, empty when nothing is.
 * @param {string} root the repository's root
 * @param {string[]} [only] the packages to check; every @veda-hq/* pin when empty
 * @returns {string[]}
 */
export function problems(root, only = []) {
  const manifest = readJson(join(root, 'package.json'));
  const pins = manifest.devDependencies ?? {};
  const names = only.length > 0 ? only : Object.keys(pins).filter((name) => name.startsWith('@veda-hq/'));
  const lockFile = join(root, 'pnpm-lock.yaml');
  // pnpm 11 and later write the package manager's own lock as a first document.
  const lock = existsSync(lockFile)
    ? (parseAllDocuments(readFileSync(lockFile, 'utf8'))
        .map((doc) => doc.toJS())
        .find((doc) => doc?.importers?.['.']?.devDependencies !== undefined) ?? {})
    : undefined;
  const realRoot = realpathSync(root) + sep;
  const store = join(realRoot, 'node_modules', '.pnpm') + sep;
  const found = [];
  for (const name of names) {
    const pin = pins[name];
    if (pin === undefined) {
      found.push(`${name} is not a devDependency of package.json`);
      continue;
    }
    if (!EXACT.test(pin)) {
      found.push(`${name} is pinned as "${pin}", not as an exact released version`);
      continue;
    }
    if (lock === undefined) {
      found.push(`there is no pnpm-lock.yaml in ${root}; run pnpm install`);
      break;
    }
    const locked = lockProblem(lock, name, pin);
    if (locked !== undefined) {
      found.push(locked);
      continue;
    }
    const dir = join(root, 'node_modules', ...name.split('/'));
    if (!existsSync(join(dir, 'package.json'))) {
      found.push(`${name} ${pin} is not installed in ${root}; run pnpm install there`);
      continue;
    }
    const real = realpathSync(dir) + sep;
    if (real.startsWith(realRoot) && !real.startsWith(store)) {
      found.push(`${name} resolves to ${relative(realRoot, real)}, a folder of this checkout, not the released ${pin}`);
      continue;
    }
    const version = readJson(join(dir, 'package.json')).version;
    if (version !== pin) found.push(`${name} ${version} is installed, but package.json pins ${pin}; run pnpm install in ${root}`);
  }
  return found;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let root = process.cwd();
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (argv[i + 1] === undefined) {
        console.error('usage: released-pins.mjs [--root <dir>] [package…]');
        return 2;
      }
      root = argv[++i];
    } else {
      only.push(argv[i]);
    }
  }
  const found = problems(root, only);
  for (const problem of found) console.error(`released-pins: ${problem}`);
  return found.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
