import { SETTINGS_PATH } from './agent.ts';
import type { Sys } from './types.ts';

/**
 * What a client can turn on, one at a time. identity is always on: the
 * settings, the session-start hook, the agent's access and its Verified
 * commit. Each other feature is one shared check or one part of onboard.
 */
export const FEATURES = ['identity', 'pr-identity', 'board', 'work-rules', 'figma', 'decisions', 'review'] as const;
export type Feature = (typeof FEATURES)[number];

/** A Figma file key, as FIGMA_LIBRARY and the older `figma.library` hold it. */
export const FIGMA_FILE_KEY = /^[A-Za-z0-9]+$/;

/** Features renamed since older releases wrote them, still read as their new name. */
const RENAMED = new Map<string, Feature>([['design', 'figma']]);

const isFeature = (name: string): name is Feature => (FEATURES as readonly string[]).includes(name);
const named = (name: string): string => RENAMED.get(name.trim()) ?? name.trim();

/** A comma-separated list of features, checked, with identity always among them. */
export function parseFeatures(list: string): Feature[] {
  const names = list.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !isFeature(name));
  if (unknown.length > 0) throw new Error(`unknown feature ${unknown.join(', ')}; the features are ${FEATURES.join(', ')}`);
  return FEATURES.filter((feature) => feature === 'identity' || names.includes(feature));
}

/** The features parsed settings turn on: every feature when they list none, as before staged adoption. */
export function featuresIn(raw: unknown): Feature[] {
  const listed = (raw as { features?: unknown } | null)?.features;
  if (listed === undefined) return [...FEATURES];
  if (!Array.isArray(listed) || !listed.every((name): name is string => typeof name === 'string')) {
    throw new Error(`${SETTINGS_PATH}: "features" must be a list of feature names`);
  }
  const unknown = listed.filter((name) => !isFeature(named(name)));
  if (unknown.length > 0) throw new Error(`${SETTINGS_PATH}: unknown feature ${unknown.map((name) => JSON.stringify(name)).join(', ')}; the features are ${FEATURES.join(', ')}`);
  return FEATURES.filter((feature) => feature === 'identity' || listed.some((name) => named(name) === feature));
}

/** A line for each feature the parsed settings list by an older name, saying what it is now. */
export function renamedLines(raw: unknown): string[] {
  const listed = (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((name) =>
    typeof name === 'string' && RENAMED.has(name.trim()) ? [`${SETTINGS_PATH} lists "${name.trim()}", which is now named "${RENAMED.get(name.trim())}"; run process-rules onboard to rename it`] : [],
  );
}

/** Whether the settings at `root` turn `feature` on. */
export function isOn(sys: Sys, root: string, feature: Feature): boolean {
  return featuresIn(JSON.parse(sys.read(`${root}/${SETTINGS_PATH}`))).includes(feature);
}

/** The line a check prints when its feature is off. */
export function offLine(command: string, feature: Feature): string {
  return `${command}: ${feature} is off in ${SETTINGS_PATH}; nothing to check`;
}

/**
 * The line a pull request check prints when the base branch it reads the
 * settings from has none, as in the pull request that first commits them:
 * the repo is not adopted on its base yet, so the check passes, as for a
 * feature that is off. Undefined when the settings are there.
 */
export function notAdoptedLine(sys: Sys, root: string, command: string): string | undefined {
  if (sys.exists(`${root}/${SETTINGS_PATH}`)) return undefined;
  return `${command}: the base branch has no ${SETTINGS_PATH}, so the repo is not adopted on its base yet; nothing to check`;
}
