import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sodium from 'libsodium-wrappers';

import { FakeSys } from './fake.test.ts';
import { setSecret } from './secrets.ts';

const REPO = '/repos/example-org/example-app/actions/secrets';
const VALUE = 'LibKey0123abc';

interface Pair {
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

describe('setSecret', () => {
  it("seals the value with the repository's Actions public key and stores it", async () => {
    const sys = new FakeSys();
    const pair = await actionsKey(sys);
    assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), undefined);
    const sent = sealedValue(sys, pair);
    assert.deepEqual([sent.value, sent.keyId, sent.token], [VALUE, 'key-1', 'gho_owner']);
    assert.ok(!sent.encrypted.includes(VALUE));
    assert.ok(!JSON.stringify(sys.requests).includes(VALUE), 'the value never leaves in the clear');
  });

  it('takes a replaced secret too', async () => {
    const sys = new FakeSys();
    await actionsKey(sys, { status: 204, json: null });
    assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), undefined);
  });

  it('says why when GitHub gives no public key, or one that is not a key', async () => {
    const sys = new FakeSys();
    assert.equal(
      await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE),
      "GitHub did not give example-org/example-app's Actions public key (HTTP 404), so the FIGMA_LIBRARY secret is not set",
    );
    sys.route('GET', `${REPO}/public-key`, { status: 200, json: { key_id: 'key-1', key: 'c2hvcnQ=' } });
    assert.equal(
      await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE),
      "example-org/example-app's Actions public key is not one a secret can be sealed with, so the FIGMA_LIBRARY secret is not set",
    );
    assert.ok(!sys.requests.some((r) => r.method === 'PUT'));
  });

  it('says why GitHub refused the secret, never naming the value', async () => {
    for (const [json, said] of [
      [{ message: 'Must have admin rights to Repository.' }, 'GitHub did not set the FIGMA_LIBRARY secret (HTTP 403: Must have admin rights to Repository.)'],
      [null, 'GitHub did not set the FIGMA_LIBRARY secret (HTTP 403)'],
    ] as const) {
      const sys = new FakeSys();
      await actionsKey(sys, { status: 403, json });
      assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), said);
    }
  });
});
