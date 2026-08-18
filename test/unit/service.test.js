import test from 'node:test';
import assert from 'node:assert/strict';
import { ProximityService } from '../../src/service.js';

const owner = 'a'.repeat(64);
const placeId = '018f5e4a-20d3-7c3b-ae8c-3db8540fbccd';
const versionId = '018f5e4a-20d3-7c3b-ae8c-3db8540fbccc';
const sessionId = '018f5e4a-20d3-7c3b-ae8c-3db8540fbcce';
const pageSecret = 'page-token-secret-at-least-thirty-two-bytes';

class FakeRepository {
  constructor() {
    this.calls = [];
    this.preconditionFailure = false;
  }

  async createPlace(args) {
    this.calls.push(['create', args]);
    return {
      outcome: 'applied', operation: 'create', placeId, versionId, versionNumber: 1,
      catalogRevision: 1, replayed: false,
    };
  }

  async updatePlace(args) {
    this.calls.push(['update', args]);
    return {
      outcome: this.preconditionFailure ? 'precondition_failed' : 'applied',
      operation: 'update', placeId, versionId, versionNumber: 1,
      catalogRevision: this.preconditionFailure ? null : 2, replayed: this.preconditionFailure,
    };
  }

  async createSearchSession(args) {
    this.calls.push(['search', args]);
    return {
      sessionId, snapshotRevision: 4, pageSize: 1, resultCount: 2,
      createdAt: new Date('2026-08-19T00:00:00Z'),
      expiresAt: new Date('2026-08-19T00:30:00Z'), replayed: false,
    };
  }

  async getSearchPage({ startOrdinal }) {
    this.calls.push(['page', startOrdinal]);
    return {
      session: {
        sessionId, snapshotRevision: 4, pageSize: 1, resultCount: 2,
        expiresAt: new Date('2026-08-19T00:30:00Z'),
      },
      startOrdinal,
      items: [{
        placeId: startOrdinal === 0 ? placeId : '018f5e4a-20d3-7c3b-ae8c-3db8540fbc00',
        versionId, name: 'Cafe One', category: 'coffee', latitude: 1,
        longitude: 2, distanceMillimeters: 3,
      }],
    };
  }
}

test('service freezes canonical mutation intent and returns a strong ETag', async () => {
  const repository = new FakeRepository();
  const service = new ProximityService(repository, { pageTokenSecret: pageSecret });
  const result = await service.createPlace({
    owner,
    requestKey: 'create-1',
    body: { name: 'Cafe One', category: 'coffee', latitude: -0, longitude: 180 },
  });
  assert.equal(result.created, true);
  assert.equal(result.etag, `\"pv:${versionId}\"`);
  assert.equal(repository.calls[0][1].input.latitude, 0);
  assert.equal(repository.calls[0][1].input.longitude, -180);
  assert.match(repository.calls[0][1].digest, /^[0-9a-f]{64}$/);
});

test('durable stale mutation is surfaced as 412 with the recorded current ETag', async () => {
  const repository = new FakeRepository();
  repository.preconditionFailure = true;
  const service = new ProximityService(repository, { pageTokenSecret: pageSecret });
  await assert.rejects(service.updatePlace({
    owner,
    requestKey: 'update-1',
    ifMatch: `\"pv:${versionId}\"`,
    placeId,
    body: { name: 'Cafe One', category: 'coffee', latitude: 1, longitude: 2, state: 'active' },
  }), (error) => error.status === 412 && error.details.etag === `\"pv:${versionId}\"`);
});

test('materialized pagination token advances one immutable ordinal page', async () => {
  const repository = new FakeRepository();
  const service = new ProximityService(repository, { pageTokenSecret: pageSecret });
  const first = await service.createSearchSession({
    owner,
    requestKey: 'search-1',
    body: { latitude: 1, longitude: 2, radiusMeters: 1000, pageSize: 1 },
  });
  assert.equal(first.created, true);
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.nextPageToken);
  const second = await service.getSearchPage({
    owner, sessionId, pageToken: first.body.nextPageToken,
  });
  assert.equal(second.body.items.length, 1);
  assert.equal(Object.hasOwn(second.body, 'nextPageToken'), false);
  assert.deepEqual(repository.calls.at(-1), ['page', 1]);
});
