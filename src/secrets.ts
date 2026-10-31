import { API } from './agent.ts';
import type { Sys } from './types.ts';

/**
 * Sets the Actions secret `name` of `slug` to `value`, as the account `token`
 * is: GitHub takes a secret only sealed with the repository's Actions public
 * key, as a libsodium sealed box, so the value never reaches GitHub, or any
 * output, in the clear. Returns why it failed, never naming the value.
 */
export async function setSecret(sys: Sys, slug: string, token: string, name: string, value: string): Promise<string | undefined> {
  const asked = await sys.http(`${API}/repos/${slug}/actions/secrets/public-key`, { token });
  const { key_id: id, key } = (asked.json ?? {}) as { key_id?: unknown; key?: unknown };
  if (asked.status !== 200 || typeof id !== 'string' || typeof key !== 'string') {
    return `GitHub did not give ${slug}'s Actions public key (HTTP ${asked.status}), so the ${name} secret is not set`;
  }
  // Loaded here alone: the shared checks run the CLI from its source with no packages installed.
  const { default: sodium } = await import('libsodium-wrappers');
  await sodium.ready;
  let sealed: Uint8Array;
  try {
    sealed = sodium.crypto_box_seal(new TextEncoder().encode(value), Buffer.from(key, 'base64'));
  } catch {
    return `${slug}'s Actions public key is not one a secret can be sealed with, so the ${name} secret is not set`;
  }
  const put = await sys.http(`${API}/repos/${slug}/actions/secrets/${name}`, {
    method: 'PUT',
    token,
    body: { encrypted_value: Buffer.from(sealed).toString('base64'), key_id: id },
  });
  // 201: made; 204: replaced.
  if (put.status === 201 || put.status === 204) return undefined;
  const why = (put.json as { message?: unknown } | null)?.message;
  return `GitHub did not set the ${name} secret (HTTP ${put.status}${typeof why === 'string' ? `: ${why}` : ''})`;
}
