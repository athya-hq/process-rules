import { API, SETTINGS_PATH } from './agent.ts';
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

/**
 * The line a check prints when its feature is off: off in the settings, or,
 * given `why`, off for that reason whatever the settings say.
 */
export function offLine(command: string, feature: Feature, why?: string): string {
  return `${command}: ${feature} is off ${why ?? `in ${SETTINGS_PATH}`}; nothing to check`;
}

/**
 * Features that need GitHub's issue types: the work rules need a Slice under
 * a Work item, the weekly job and reviews-due list issues by type, and the
 * design check reads a slice's State sub-issues.
 */
export const NEEDS_ISSUE_TYPES: readonly Feature[] = ['work-rules', 'figma', 'decisions'];

/** Why a feature that needs issue types cannot run on a repository a personal account owns. */
export const PERSONAL_REPO = 'on a repository owned by a personal account, since GitHub has issue types for organisations only';

/** Whether a repository is a personal account's, by repository, asked of GitHub once per run. */
const personal = new WeakMap<Sys, Map<string, Promise<boolean>>>();

/** Whether a personal account owns repository `slug`, from GitHub's `owner.type`; throws when GitHub will not say. */
export function isPersonal(sys: Sys, slug: string, token: string): Promise<boolean> {
  const asked = personal.get(sys) ?? new Map<string, Promise<boolean>>();
  personal.set(sys, asked);
  let answer = asked.get(slug);
  if (!answer) {
    answer = (async () => {
      const { status, json } = await sys.http(`${API}/repos/${slug}`, { token });
      const type = (json as { owner?: { type?: unknown } } | null)?.owner?.type;
      if (status !== 200 || typeof type !== 'string') throw new Error(`cannot tell whether a personal account owns ${slug} (HTTP ${status})`);
      return type === 'User';
    })();
    asked.set(slug, answer);
  }
  return answer;
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

/** When the weekly decisions job runs, unless the settings say otherwise: Mondays, 06:17 UTC. */
export const DEFAULT_SCHEDULE = '17 6 * * 1';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** Each cron field's lowest and highest value, and the names it takes for them. */
const CRON_FIELDS: { low: number; high: number; names?: string[] }[] = [
  { low: 0, high: 59 },
  { low: 0, high: 23 },
  { low: 1, high: 31 },
  { low: 1, high: 12, names: MONTHS },
  { low: 0, high: 6, names: DAYS },
];

/** Whether one cron field is a list of `*`, values or ranges, each with an optional `/step`, within its bounds. */
function cronField(text: string, { low, high, names }: { low: number; high: number; names?: string[] }): boolean {
  const value = (part: string): number | undefined => {
    const index = names?.indexOf(part.toUpperCase()) ?? -1;
    if (index >= 0) return index + low;
    return /^\d+$/.test(part) && Number(part) >= low && Number(part) <= high ? Number(part) : undefined;
  };
  return text.split(',').every((item) => {
    const match = /^(\*|[^-/]+(?:-[^-/]+)?)(?:\/(\d+))?$/.exec(item);
    if (!match || (match[2] !== undefined && Number(match[2]) < 1)) return false;
    if (match[1] === '*') return true;
    const [from, to] = (match[1] as string).split('-').map(value);
    return from !== undefined && (to === undefined ? !(match[1] as string).includes('-') : to >= from);
  });
}

/** The decisions job's schedule the parsed settings set, checked as a five-field cron, or the default. */
export function scheduleIn(raw: unknown): string {
  const schedule = (raw as { schedule?: unknown } | null)?.schedule;
  if (schedule === undefined) return DEFAULT_SCHEDULE;
  const fields = typeof schedule === 'string' ? schedule.trim().split(/\s+/) : [];
  if (fields.length !== 5 || !fields.every((field, index) => cronField(field, CRON_FIELDS[index] as (typeof CRON_FIELDS)[number]))) {
    throw new Error(`${SETTINGS_PATH}: "schedule" must be a five-field cron, such as "${DEFAULT_SCHEDULE}" (Mondays, 06:17 UTC)`);
  }
  return fields.join(' ');
}
