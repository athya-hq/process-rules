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
  /** Whether the token is held only under an older name, so `machine` copies it to the current one. */
  onlyOlder?(sys: Sys, agent: string): boolean;
}

/**
 * The keychain item holding the agent account's token: service, account =
 * login. Releases before niyam stored it under the service `process-rules`,
 * which is still read and never deleted, so an older CLI on the Mac keeps
 * working (P-50).
 */
export const KEYCHAIN_SERVICE = 'niyam';
export const OLD_KEYCHAIN_SERVICE = 'process-rules';
const SECURITY = '/usr/bin/security';

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
  read: (sys, agent) => readFrom(sys, KEYCHAIN_SERVICE, agent) ?? readFrom(sys, OLD_KEYCHAIN_SERVICE, agent),
  store(sys, agent, token) {
    // Only characters the `security -i` prompt reads as one word.
    if (!/^[A-Za-z0-9_]+$/.test(token)) return false;
    const result = sys.exec(SECURITY, ['-i'], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${agent} -w ${token}\n`,
    });
    return result.code === 0 && readFrom(sys, KEYCHAIN_SERVICE, agent) === token;
  },
  readCommand: (agent) => `${find(KEYCHAIN_SERVICE, agent)} || ${find(OLD_KEYCHAIN_SERVICE, agent)}`,
  olderReadCommands: (agent) => [find(OLD_KEYCHAIN_SERVICE, agent)],
  onlyOlder: (sys, agent) => readFrom(sys, KEYCHAIN_SERVICE, agent) === undefined && readFrom(sys, OLD_KEYCHAIN_SERVICE, agent) !== undefined,
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
