import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { invalid } from './errors.js';
import { parseUuid } from './contracts.js';

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function intentDigest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function ownerFingerprint(authToken, secret) {
  return createHmac('sha256', secret).update(authToken).digest('hex');
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest();
}

export function encodePageToken({ owner, session, next }, secret) {
  const payload = Buffer.from(stableJson({ next, owner, session, v: 1 })).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function decodePageToken(token, expectedOwner, secret) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 1_024) {
    throw invalid('page token is invalid');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw invalid('page token is invalid');
  const [payload, encodedSignature] = parts;
  let supplied;
  let parsed;
  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== payload) throw new Error('non-canonical encoding');
    parsed = JSON.parse(text);
  } catch {
    throw invalid('page token is invalid');
  }
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw invalid('page token is invalid');
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || stableJson(parsed) !== stableJson({ next: parsed.next, owner: parsed.owner, session: parsed.session, v: parsed.v })
    || parsed.v !== 1
    || parsed.owner !== expectedOwner
    || typeof parsed.owner !== 'string'
    || !/^[0-9a-f]{64}$/.test(parsed.owner)
    || !Number.isSafeInteger(parsed.next)
    || parsed.next < 1
  ) {
    throw invalid('page token is invalid');
  }
  parseUuid(parsed.session, 'page token session');
  return { session: parsed.session, next: parsed.next };
}
