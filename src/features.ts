import { SETTINGS_PATH } from './agent.ts';
import type { Sys } from './types.ts';

/**
 * What a client can turn on, one at a time. identity is always on: the
 * settings, the session-start hook, the agent's access and its Verified
 * commit. Each other feature is one shared check or one part of onboard.
 */
export const FEATURES = ['identity', 'pr-identity', 'board', 'work-rules', 'design', 'decisions', 'review'] as const;
export type Feature = (typeof FEATURES)[number];

const isFeature = (name: string): name is Feature => (FEATURES as readonly string[]).includes(name);

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
  return parseFeatures(listed.join(','));
}

/** Whether the settings at `root` turn `feature` on. */
export function isOn(sys: Sys, root: string, feature: Feature): boolean {
  return featuresIn(JSON.parse(sys.read(`${root}/${SETTINGS_PATH}`))).includes(feature);
}

/** The line a check prints when its feature is off. */
export function offLine(command: string, feature: Feature): string {
  return `${command}: ${feature} is off in ${SETTINGS_PATH}; nothing to check`;
}
