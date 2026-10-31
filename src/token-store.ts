import type { Sys } from './types.ts';

/** The platforms process-rules runs on, for the message on any other. */
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
}

/** The keychain item holding the agent account's token: service, account = login. */
export const KEYCHAIN_SERVICE = 'process-rules';
const SECURITY = '/usr/bin/security';

/** The macOS keychain, through Apple's `security` command. */
export const KEYCHAIN: TokenStore = {
  where: "this Mac's keychain",
  item: (agent) => `service ${KEYCHAIN_SERVICE}, account ${agent}`,
  read(sys, agent) {
    const result = sys.exec(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', agent, '-w']);
    const token = result.stdout.trim();
    return result.code === 0 && token ? token : undefined;
  },
  store(sys, agent, token) {
    // Only characters the `security -i` prompt reads as one word.
    if (!/^[A-Za-z0-9_]+$/.test(token)) return false;
    const result = sys.exec(SECURITY, ['-i'], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${agent} -w ${token}\n`,
    });
    return result.code === 0 && KEYCHAIN.read(sys, agent) === token;
  },
  readCommand: (agent) => `${SECURITY} find-generic-password -s ${KEYCHAIN_SERVICE} -a ${agent} -w 2>/dev/null`,
};

/** Each platform's store, by Node's name for the platform. */
const STORES: Readonly<Record<string, TokenStore>> = { darwin: KEYCHAIN };

/** This machine's token store, or undefined on a platform process-rules does not support. */
export function tokenStore(sys: Sys): TokenStore | undefined {
  return Object.hasOwn(STORES, sys.platform) ? STORES[sys.platform] : undefined;
}

/** Why this machine cannot hold the agent's token. */
export function unsupported(sys: Sys): string {
  return `process-rules supports ${SUPPORTED_PLATFORMS} only, where the keychain holds the agent's token; this machine runs ${sys.platform}`;
}
