import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNewer } from './version.ts';

describe('isNewer', () => {
  it('orders releases by number, not as text', () => {
    assert.equal(isNewer('0.5.27', '0.5.20'), true);
    assert.equal(isNewer('0.5.10', '0.5.9'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.5.20', '0.5.27'), false);
    assert.equal(isNewer('0.5.27', '0.5.27'), false, 'the same release is not newer');
  });

  it('is false for anything that is not a release number', () => {
    assert.equal(isNewer('main', '0.5.27'), false);
    assert.equal(isNewer('0.5', '0.4.0'), false);
  });
});
