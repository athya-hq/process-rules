/**
 * The one GitHub host process-rules works with (docs/decisions.md, P-30).
 * Every GitHub address in src/ derives from it, so a host setting can come
 * later by changing this module alone; host.test.ts keeps the rule.
 */
export const GITHUB_HOST = 'github.com';
/** The host as a RegExp source, its dots escaped. */
export const GITHUB_HOST_RE = GITHUB_HOST.replaceAll('.', '\\.');
/** Web pages and HTTPS remotes. */
export const GITHUB_WEB = `https://${GITHUB_HOST}`;
/** The REST API. */
export const GITHUB_API = `https://api.${GITHUB_HOST}`;
/** The SSH login, as in `git@github.com:owner/repo`. */
export const GITHUB_SSH = `git@${GITHUB_HOST}`;
/** GitHub's SSH over port 443. */
export const GITHUB_SSH_443 = `git@ssh.${GITHUB_HOST}`;
/** Where no-reply commit addresses live. */
export const GITHUB_NOREPLY = `users.noreply.${GITHUB_HOST}`;
