import sodium from 'libsodium-wrappers';

import type { FakeSys } from './fake.test.ts';

const REPO = '/repos/example-org/example-app/actions/secrets';

export interface Pair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** A repository whose Actions public key is a fresh one, and the pair to open what is sealed with it. */
export async function actionsKey(sys: FakeSys, put = { status: 201, json: null as unknown }): Promise<Pair> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  sys.route('GET', `${REPO}/public-key`, { status: 200, json: { key_id: 'key-1', key: Buffer.from(pair.publicKey).toString('base64') } });
  sys.route('PUT', `${REPO}/FIGMA_LIBRARY`, { status: put.status, json: put.json });
  return pair;
}

/** What the PUT of the secret carried, opened with `pair`. */
export function sealedValue(sys: FakeSys, pair: Pair): { value: string; keyId: unknown; token: string | undefined; encrypted: string } {
  const put = sys.requests.find((r) => r.method === 'PUT' && r.url.endsWith(`${REPO}/FIGMA_LIBRARY`));
  const body = put?.body as { encrypted_value: string; key_id: unknown };
  const opened = sodium.crypto_box_seal_open(Buffer.from(body.encrypted_value, 'base64'), pair.publicKey, pair.privateKey);
  return { value: new TextDecoder().decode(opened), keyId: body.key_id, token: put?.token, encrypted: body.encrypted_value };
}
