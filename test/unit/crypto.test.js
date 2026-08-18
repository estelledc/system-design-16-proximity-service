import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePageToken,
  encodePageToken,
  intentDigest,
  ownerFingerprint,
  stableJson,
} from '../../src/crypto.js';

const secret = 'page-token-secret-at-least-thirty-two-bytes';
const owner = 'a'.repeat(64);
const session = '018f5e4a-20d3-7c3b-ae8c-3db8540fbccd';

test('canonical JSON and intent digests ignore object insertion order', () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(intentDigest({ a: 1, b: 2 }), intentDigest({ b: 2, a: 1 }));
  assert.notEqual(intentDigest({ a: 1 }), intentDigest({ a: 2 }));
});

test('owner fingerprints are deterministic and secret-separated', () => {
  assert.equal(ownerFingerprint('owner-token', 'x'.repeat(32)).length, 64);
  assert.equal(
    ownerFingerprint('owner-token', 'x'.repeat(32)),
    ownerFingerprint('owner-token', 'x'.repeat(32)),
  );
  assert.notEqual(
    ownerFingerprint('owner-token', 'x'.repeat(32)),
    ownerFingerprint('owner-token', 'y'.repeat(32)),
  );
});

test('page tokens bind owner, session, ordinal, and signature', () => {
  const token = encodePageToken({ owner, session, next: 20 }, secret);
  assert.deepEqual(decodePageToken(token, owner, secret), { session, next: 20 });
  assert.throws(() => decodePageToken(`${token.slice(0, -1)}A`, owner, secret), /invalid/);
  assert.throws(() => decodePageToken(token, 'b'.repeat(64), secret), /invalid/);
  assert.throws(() => decodePageToken(token, owner, `${secret}-changed`), /invalid/);
});
