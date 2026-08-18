import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalLatitude,
  canonicalLongitude,
  formatEtag,
  parseCreatePlace,
  parseIfMatch,
  parseRequestKey,
  parseSearch,
  parseUpdatePlace,
  parseUuid,
} from '../../src/contracts.js';

const id = '018f5e4a-20d3-7c3b-ae8c-3db8540fbccd';

test('coordinates use a finite canonical longitude/latitude domain', () => {
  assert.equal(canonicalLatitude(-0), 0);
  assert.equal(canonicalLongitude(180), -180);
  assert.equal(canonicalLongitude(-0), 0);
  for (const value of [NaN, Infinity, -Infinity, '1', null]) {
    assert.throws(() => canonicalLatitude(value), /finite JSON number/);
  }
  assert.throws(() => canonicalLatitude(90.0001), /between -90 and 90/);
  assert.throws(() => canonicalLongitude(-180.0001), /between -180 and 180/);
});

test('place payloads reject unknown, partial, Unicode, and ambiguous lifecycle fields', () => {
  assert.deepEqual(parseCreatePlace({
    name: 'Cafe One', category: 'coffee', latitude: 37.7, longitude: -122.4,
  }), {
    name: 'Cafe One', category: 'coffee', latitude: 37.7, longitude: -122.4,
  });
  assert.throws(() => parseCreatePlace({
    name: 'Cafe One', category: 'coffee', latitude: 37.7, longitude: -122.4, rating: 5,
  }), /documented contract/);
  assert.throws(() => parseCreatePlace({
    name: '咖啡', category: 'coffee', latitude: 37.7, longitude: -122.4,
  }), /printable ASCII/);
  assert.throws(() => parseUpdatePlace({
    name: 'Cafe One', category: 'coffee', latitude: 37.7, longitude: -122.4, state: 'deleted',
  }), /active or closed/);
});

test('search bounds radius, page work, category, and exact shape', () => {
  assert.deepEqual(parseSearch({
    latitude: 1, longitude: 180, radiusMeters: 50_000, pageSize: 100, category: 'late-night',
  }), {
    latitude: 1, longitude: -180, radiusMeters: 50_000, pageSize: 100, category: 'late-night',
  });
  assert.throws(() => parseSearch({ latitude: 1, longitude: 2, radiusMeters: 0, pageSize: 10 }), /radiusMeters/);
  assert.throws(() => parseSearch({ latitude: 1, longitude: 2, radiusMeters: 10, pageSize: 101 }), /pageSize/);
  assert.throws(() => parseSearch({
    latitude: 1, longitude: 2, radiusMeters: 10, pageSize: 1, category: 'Coffee',
  }), /kebab-case/);
});

test('request IDs, idempotency keys, and ETags are single canonical values', () => {
  assert.equal(parseUuid(id), id);
  assert.equal(parseRequestKey('owner:create:0001'), 'owner:create:0001');
  assert.equal(formatEtag(id), `\"pv:${id}\"`);
  assert.equal(parseIfMatch(`\"pv:${id}\"`), id);
  assert.throws(() => parseIfMatch(`W/\"pv:${id}\"`), /strong/);
  assert.throws(() => parseIfMatch(`\"pv:${id}\", \"pv:${id}\"`), /exactly one/);
  assert.throws(() => parseRequestKey('has a space'), /portable ASCII/);
});
