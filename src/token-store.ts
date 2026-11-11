import type { Sys } from './types.ts';

/** The platforms niyam runs on, for the message on any other. */
export const SUPPORTED_PLATFORMS = 'macOS';

/**
 * Where a machine keeps the agent account's token. Everything that reads or
 * stores the token goes through one, so another platform's store is one more
 * implementation, not a change to its callers (docs/decisions.md, P-29).
 */
export interface TokenStore {
  /** The store, for messages: "this Mac's keychain". */
  where: string;
  /** The item holding an agent's token, for the question before storing it. */
  item(agent: string): string;
  /** The agent's token, or undefined when the store has none. */
  read(sys: Sys, agent: string): string | undefined;
  /** Stores the token without putting it on any command line; true once the store gives it back. */
  store(sys: Sys, agent: string, token: string): boolean;
  /** A shell command printing the agent's token, for the session file, which reads it on each use. */
  readCommand(agent: string): string;
  /** The commands older releases wrote in the session file, which still read the token. */
  olderReadCommands?(agent: string): string[];
  /**
   * The item an older release kept the token in, for messages; with
   * `leftover`, the token still in it, or undefined when there is none, and
   * `dropLeftover`, which deletes it: undefined once the store says it is
   * gone, else why it may not be. Only
   * `machine` deletes it and only `doctor` reports it; nothing reads a token
   * from it.
   */
  leftoverItem?(agent: string): string;
  leftover?(sys: Sys, agent: string): string | undefined;
  dropLeftover?(sys: Sys, agent: string): string | undefined;
  /** The shell command that deletes the leftover item by hand. */
  dropLeftoverCommand?(agent: string): string;
}

/**
 * The keychain item holding the agent account's token: service, account =
 * login. Releases before niyam stored it under the service `process-rules`,
 * which no release reads since P-57: `machine` deletes that entry once the
 * `niyam` one holds the same token, and `doctor` reports one still there.
 */
export const KEYCHAIN_SERVICE = 'niyam';
/** The service before niyam (P-50), named only to delete it. */
export const LEFTOVER_SERVICE = 'process-rules';
const SECURITY = '/usr/bin/security';
/** The exit code `security` gives when the keychain has no such item: the one answer that says it is gone. */
const NOT_FOUND = 44;

function find(service: string, agent: string): string {
  return `${SECURITY} find-generic-password -s ${service} -a ${agent} -w 2>/dev/null`;
}

function readFrom(sys: Sys, service: string, agent: string): string | undefined {
  const result = sys.exec(SECURITY, ['find-generic-password', '-s', service, '-a', agent, '-w']);
  const token = result.stdout.trim();
  return result.code === 0 && token ? token : undefined;
}

/** The macOS keychain, through Apple's `security` command. */
export const KEYCHAIN: TokenStore = {
  where: "this Mac's keychain",
  item: (agent) => `service ${KEYCHAIN_SERVICE}, account ${agent}`,
  read: (sys, agent) => readFrom(sys, KEYCHAIN_SERVICE, agent),
  store(sys, agent, token) {
    // Only characters the `security -i` prompt reads as one word.
    if (!/^[A-Za-z0-9_]+$/.test(token)) return false;
    const result = sys.exec(SECURITY, ['-i'], { input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${agent} -w ${token}\n` });
    return result.code === 0 && readFrom(sys, KEYCHAIN_SERVICE, agent) === token;
  },
  readCommand: (agent) => find(KEYCHAIN_SERVICE, agent),
  // 0.6.10's session file, which fell back to the entry before niyam: data compared against, not a read of it.
  olderReadCommands: (agent) => [`${find(KEYCHAIN_SERVICE, agent)} || ${find(LEFTOVER_SERVICE, agent)}`],
  leftoverItem: (agent) => `service ${LEFTOVER_SERVICE}, account ${agent}`,
  leftover: (sys, agent) => readFrom(sys, LEFTOVER_SERVICE, agent),
  dropLeftover(sys, agent) {
    const deleted = sys.exec(SECURITY, ['delete-generic-password', '-s', LEFTOVER_SERVICE, '-a', agent]);
    const found = sys.exec(SECURITY, ['find-generic-password', '-s', LEFTOVER_SERVICE, '-a', agent]);
    if (found.code === NOT_FOUND) return undefined;
    const said = (result: { code: number; stderr: string }): string => result.stderr.trim() || `exit ${result.code}`;
    return found.code === 0
      ? `the keychain still holds it after the delete (${said(deleted)})`
      : `the keychain could not say whether it is gone (${said(found)})`;
  },
  dropLeftoverCommand: (agent) => `${SECURITY} delete-generic-password -s ${LEFTOVER_SERVICE} -a ${agent}`,
};

/** Each platform's store, by Node's name for the platform. */
const STORES: Readonly<Record<string, TokenStore>> = { darwin: KEYCHAIN };

/** This machine's token store, or undefined on a platform niyam does not support. */
export function tokenStore(sys: Sys): TokenStore | undefined {
  return Object.hasOwn(STORES, sys.platform) ? STORES[sys.platform] : undefined;
}

/** Why this machine cannot hold the agent's token. */
export function unsupported(sys: Sys): string {
  return `niyam supports ${SUPPORTED_PLATFORMS} only, where the keychain holds the agent's token; this machine runs ${sys.platform}`;
}
