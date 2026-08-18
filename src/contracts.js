import { invalid } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CATEGORY = /^[a-z][a-z0-9-]{0,39}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object`);
  }
  return value;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = keys.filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw invalid('request fields do not match the documented contract');
  }
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${label} must be a finite JSON number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalLatitude(value) {
  const latitude = finiteNumber(value, 'latitude');
  if (latitude < -90 || latitude > 90) {
    throw invalid('latitude must be between -90 and 90');
  }
  return latitude;
}

export function canonicalLongitude(value) {
  const longitude = finiteNumber(value, 'longitude');
  if (longitude < -180 || longitude > 180) {
    throw invalid('longitude must be between -180 and 180');
  }
  return longitude === 180 ? -180 : longitude;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function name(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 100
    || value !== value.trim()
    || !PRINTABLE_ASCII.test(value)
  ) {
    throw invalid('name must be 1-100 trimmed printable ASCII characters');
  }
  return value;
}

function category(value) {
  if (typeof value !== 'string' || !CATEGORY.test(value)) {
    throw invalid('category must match lowercase kebab-case and be at most 40 characters');
  }
  return value;
}

export function parseRequestKey(value) {
  if (typeof value !== 'string' || !REQUEST_KEY.test(value)) {
    throw invalid('Idempotency-Key must be 1-128 portable ASCII characters');
  }
  return value;
}

export function parseUuid(value, label = 'resource ID') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalid(`${label} must be a canonical UUID`);
  }
  return value;
}

export function parseCreatePlace(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['name', 'category', 'latitude', 'longitude']);
  return {
    name: name(body.name),
    category: category(body.category),
    latitude: canonicalLatitude(body.latitude),
    longitude: canonicalLongitude(body.longitude),
  };
}

export function parseUpdatePlace(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['name', 'category', 'latitude', 'longitude', 'state']);
  if (body.state !== 'active' && body.state !== 'closed') {
    throw invalid('state must be active or closed');
  }
  return {
    name: name(body.name),
    category: category(body.category),
    latitude: canonicalLatitude(body.latitude),
    longitude: canonicalLongitude(body.longitude),
    state: body.state,
  };
}

export function parseSearch(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['latitude', 'longitude', 'radiusMeters', 'pageSize'], ['category']);
  return {
    latitude: canonicalLatitude(body.latitude),
    longitude: canonicalLongitude(body.longitude),
    radiusMeters: boundedInteger(body.radiusMeters, 'radiusMeters', 1, 50_000),
    pageSize: boundedInteger(body.pageSize, 'pageSize', 1, 100),
    ...(Object.hasOwn(body, 'category') ? { category: category(body.category) } : {}),
  };
}

export function formatEtag(versionId) {
  return `\"pv:${parseUuid(versionId, 'version ID')}\"`;
}

export function parseIfMatch(value) {
  if (typeof value !== 'string' || value.includes(',')) {
    throw invalid('If-Match must contain exactly one strong place-version ETag');
  }
  const match = /^\"pv:([0-9a-f-]{36})\"$/.exec(value);
  if (!match) {
    throw invalid('If-Match must contain exactly one strong place-version ETag');
  }
  return parseUuid(match[1], 'If-Match version');
}

export const limits = Object.freeze({
  bodyBytes: 16_384,
  pageTokenChars: 1_024,
  resultRows: 500,
  sessionTtlMs: 30 * 60 * 1_000,
});
