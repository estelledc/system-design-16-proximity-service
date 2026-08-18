import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerFingerprint } from '../../src/crypto.js';
import { initializeDatabase, ProximityRepository, resetDatabase } from '../../src/repository.js';
import { ProximityService } from '../../src/service.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for PostGIS integration tests');

const pageTokenSecret = 'integration-page-token-secret-more-than-thirty-two-bytes';
const authSecret = 'integration-auth-secret-more-than-thirty-two-bytes';
const owner = ownerFingerprint('integration-owner-token', authSecret);
const otherOwner = ownerFingerprint('integration-other-token', authSecret);
const pool = new Pool({ connectionString: databaseUrl, max: 12, statement_timeout: 10_000 });
let repository;
let service;
let keyCounter = 0;

function nextKey(label) {
  keyCounter += 1;
  return `${label}-${keyCounter}`;
}

function makeService(options = {}) {
  repository = new ProximityRepository(pool, options);
  service = new ProximityService(repository, { pageTokenSecret });
}

async function createPlace(input, selectedOwner = owner) {
  return service.createPlace({ owner: selectedOwner, requestKey: nextKey('create'), body: input });
}

before(async () => {
  await initializeDatabase(pool);
});

beforeEach(async () => {
  await resetDatabase(pool, 'proximity-lab-reset');
  keyCounter = 0;
  makeService();
});

after(async () => {
  await pool.end();
});

test('CI runs the declared PostgreSQL 17 and PostGIS 3.5 family', async () => {
  const versions = await pool.query(`
    SELECT current_setting('server_version') AS postgres_version, postgis_lib_version() AS postgis_version
  `);
  assert.match(versions.rows[0].postgres_version, /^17\./);
  assert.match(versions.rows[0].postgis_version, /^3\.5\./);
});

test('mutation key replay is exact and a changed intent conflicts', async () => {
  const body = { name: 'Replay Cafe', category: 'coffee', latitude: 37.7, longitude: -122.4 };
  const first = await service.createPlace({ owner, requestKey: 'same-create-key', body });
  const replay = await service.createPlace({ owner, requestKey: 'same-create-key', body });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.body.placeId, first.body.placeId);
  assert.equal(replay.body.versionId, first.body.versionId);
  assert.equal(replay.body.catalogRevision, first.body.catalogRevision);
  await assert.rejects(service.createPlace({
    owner,
    requestKey: 'same-create-key',
    body: { ...body, longitude: -122.3 },
  }), (error) => error.status === 409 && error.code === 'intent_conflict');

  const counts = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM places) AS places,
      (SELECT count(*)::int FROM place_versions) AS versions,
      (SELECT committed_revision::int FROM catalog_state WHERE singleton) AS revision
  `);
  assert.deepEqual(counts.rows[0], { places: 1, versions: 1, revision: 1 });
});

test('two updates from one base produce one commit and one durable stale result', async () => {
  const created = await createPlace({
    name: 'Concurrent Cafe', category: 'coffee', latitude: 1, longitude: 1,
  });
  const intents = [
    { key: 'move-east', longitude: 1.01 },
    { key: 'move-west', longitude: 0.99 },
  ];
  const attempts = await Promise.allSettled(intents.map((intent) => service.updatePlace({
    owner,
    requestKey: intent.key,
    ifMatch: created.etag,
    placeId: created.body.placeId,
    body: {
      name: 'Concurrent Cafe', category: 'coffee', latitude: 1,
      longitude: intent.longitude, state: 'active',
    },
  })));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected' && result.reason.status === 412).length, 1);
  const loserIndex = attempts.findIndex((result) => result.status === 'rejected');
  await assert.rejects(service.updatePlace({
    owner,
    requestKey: intents[loserIndex].key,
    ifMatch: created.etag,
    placeId: created.body.placeId,
    body: {
      name: 'Concurrent Cafe', category: 'coffee', latitude: 1,
      longitude: intents[loserIndex].longitude, state: 'active',
    },
  }), (error) => error.status === 412);

  const state = await pool.query(`
    SELECT
      (SELECT committed_revision::int FROM catalog_state WHERE singleton) AS revision,
      (SELECT count(*)::int FROM place_versions) AS versions,
      (SELECT count(*)::int FROM mutation_requests) AS mutation_receipts,
      (SELECT count(*)::int FROM mutation_requests WHERE outcome = 'precondition_failed') AS stale_receipts
  `);
  assert.deepEqual(state.rows[0], {
    revision: 2, versions: 2, mutation_receipts: 3, stale_receipts: 1,
  });
});

test('exact geography predicate, category filter, and total-order tie break agree with a direct oracle', async () => {
  await createPlace({ name: 'East Cafe', category: 'coffee', latitude: 0, longitude: 0.005 });
  await createPlace({ name: 'West Cafe', category: 'coffee', latitude: 0, longitude: -0.005 });
  await createPlace({ name: 'East Library', category: 'library', latitude: 0, longitude: 0.004 });
  await createPlace({ name: 'Far Cafe', category: 'coffee', latitude: 0, longitude: 0.02 });

  const search = await service.createSearchSession({
    owner,
    requestKey: 'exact-search',
    body: { latitude: 0, longitude: 0, radiusMeters: 1000, pageSize: 10, category: 'coffee' },
  });
  assert.equal(search.body.items.length, 2);
  assert.ok(search.body.items.every((item) => item.distanceMillimeters <= 1_000_000));
  const sorted = [...search.body.items].sort((left, right) => (
    left.distanceMillimeters - right.distanceMillimeters || left.placeId.localeCompare(right.placeId)
  ));
  assert.deepEqual(search.body.items, sorted);

  const oracle = await pool.query(`
    WITH q AS (SELECT ST_SetSRID(ST_Point(0, 0), 4326)::geography AS location)
    SELECT p.place_id
    FROM places p CROSS JOIN q
    WHERE p.state = 'active' AND p.category = 'coffee'
      AND ST_DWithin(p.location, q.location, 1000, true)
    ORDER BY round(ST_Distance(p.location, q.location, true) * 1000)::bigint, p.place_id
  `);
  assert.deepEqual(search.body.items.map((item) => item.placeId), oracle.rows.map((row) => row.place_id));
});

test('antimeridian and polar circles do not lose the opposite-longitude neighbor', async () => {
  await createPlace({ name: 'Date East', category: 'marker', latitude: 0, longitude: 179.999 });
  await createPlace({ name: 'Date West', category: 'marker', latitude: 0, longitude: -179.999 });
  const dateline = await service.createSearchSession({
    owner, requestKey: 'dateline',
    body: { latitude: 0, longitude: 180, radiusMeters: 300, pageSize: 10, category: 'marker' },
  });
  assert.equal(dateline.body.items.length, 2);

  await resetDatabase(pool, 'proximity-lab-reset');
  await createPlace({ name: 'Pole East', category: 'marker', latitude: 89.999, longitude: 90 });
  await createPlace({ name: 'Pole West', category: 'marker', latitude: 89.999, longitude: -90 });
  const pole = await service.createSearchSession({
    owner, requestKey: 'pole',
    body: { latitude: 90, longitude: 0, radiusMeters: 200, pageSize: 10, category: 'marker' },
  });
  assert.equal(pole.body.items.length, 2);
});

test('a materialized page chain stays frozen while a new search sees move and close commits', async () => {
  const first = await createPlace({
    name: 'First Cafe', category: 'coffee', latitude: 37.7749, longitude: -122.4194,
  });
  const second = await createPlace({
    name: 'Second Cafe', category: 'coffee', latitude: 37.7749, longitude: -122.4184,
  });
  const third = await createPlace({
    name: 'Third Cafe', category: 'coffee', latitude: 37.7749, longitude: -122.4094,
  });
  const frozen = await service.createSearchSession({
    owner, requestKey: 'frozen-search',
    body: { latitude: 37.7749, longitude: -122.4194, radiusMeters: 2000, pageSize: 2, category: 'coffee' },
  });
  assert.equal(frozen.body.resultCount, 3);
  assert.deepEqual(frozen.body.items.map((item) => item.placeId), [first.body.placeId, second.body.placeId]);

  await service.updatePlace({
    owner, requestKey: 'move-third', ifMatch: third.etag, placeId: third.body.placeId,
    body: { name: 'Third Cafe', category: 'coffee', latitude: 40, longitude: -120, state: 'active' },
  });
  await service.updatePlace({
    owner, requestKey: 'close-first', ifMatch: first.etag, placeId: first.body.placeId,
    body: {
      name: 'First Cafe', category: 'coffee', latitude: 37.7749,
      longitude: -122.4194, state: 'closed',
    },
  });

  const oldSecondPage = await service.getSearchPage({
    owner, sessionId: frozen.body.sessionId, pageToken: frozen.body.nextPageToken,
  });
  assert.deepEqual(oldSecondPage.body.items.map((item) => item.placeId), [third.body.placeId]);
  assert.equal(oldSecondPage.body.items[0].longitude, -122.4094);

  const current = await service.createSearchSession({
    owner, requestKey: 'current-search',
    body: { latitude: 37.7749, longitude: -122.4194, radiusMeters: 2000, pageSize: 2, category: 'coffee' },
  });
  assert.deepEqual(current.body.items.map((item) => item.placeId), [second.body.placeId]);
  assert.equal(frozen.body.snapshotRevision, 3);
  assert.equal(current.body.snapshotRevision, 5);
});

test('501 exact matches fail explicitly and publish no partial search session', async () => {
  const ids = Array.from({ length: 501 }, () => randomUUID());
  const versions = Array.from({ length: 501 }, () => randomUUID());
  await pool.query(`
    INSERT INTO places (
      place_id, owner_fingerprint, name, category, latitude, longitude, location, state,
      version_id, version_number, committed_revision, created_at, updated_at
    )
    SELECT
      u.place_id, $3, 'Dense ' || u.ordinality, 'dense', 0,
      u.ordinality * 0.0000001,
      ST_SetSRID(ST_Point(u.ordinality * 0.0000001, 0), 4326)::geography,
      'active', u.version_id, 1, u.ordinality, now(), now()
    FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS u(place_id, version_id, ordinality)
  `, [ids, versions, owner]);
  await pool.query(`UPDATE catalog_state SET committed_revision = 501 WHERE singleton`);
  await assert.rejects(service.createSearchSession({
    owner, requestKey: 'dense-search',
    body: { latitude: 0, longitude: 0, radiusMeters: 1000, pageSize: 100, category: 'dense' },
  }), (error) => error.status === 422 && error.code === 'density_limit_exceeded');
  const count = await pool.query(`SELECT count(*)::int AS count FROM search_sessions`);
  assert.equal(count.rows[0].count, 0);
});

test('same search key converges under concurrency and changed intent still conflicts', async () => {
  await createPlace({ name: 'Only Cafe', category: 'coffee', latitude: 1, longitude: 1 });
  const request = {
    owner,
    requestKey: 'concurrent-search',
    body: { latitude: 1, longitude: 1, radiusMeters: 1000, pageSize: 10 },
  };
  const [left, right] = await Promise.all([
    service.createSearchSession(request),
    service.createSearchSession(request),
  ]);
  assert.equal(left.body.sessionId, right.body.sessionId);
  assert.deepEqual([left.created, right.created].sort(), [false, true]);
  const count = await pool.query(`SELECT count(*)::int AS count FROM search_sessions`);
  assert.equal(count.rows[0].count, 1);
  await assert.rejects(service.createSearchSession({
    ...request,
    body: { ...request.body, radiusMeters: 2000 },
  }), (error) => error.status === 409);
});

test('signed pages are owner-bound, tamper-evident, route-bound, and expiring', async () => {
  let clock = new Date('2026-08-19T08:00:00Z');
  makeService({ now: () => new Date(clock), sessionTtlMs: 1000 });
  await createPlace({ name: 'One Cafe', category: 'coffee', latitude: 1, longitude: 1 });
  await createPlace({ name: 'Two Cafe', category: 'coffee', latitude: 1, longitude: 1.001 });
  const search = await service.createSearchSession({
    owner, requestKey: 'expiring-search',
    body: { latitude: 1, longitude: 1, radiusMeters: 1000, pageSize: 1 },
  });
  await assert.rejects(service.getSearchPage({
    owner: otherOwner, sessionId: search.body.sessionId, pageToken: search.body.nextPageToken,
  }), (error) => error.status === 400);
  const tampered = `${search.body.nextPageToken.slice(0, -1)}A`;
  await assert.rejects(service.getSearchPage({
    owner, sessionId: search.body.sessionId, pageToken: tampered,
  }), (error) => error.status === 400);
  await assert.rejects(service.getSearchPage({
    owner,
    sessionId: '018f5e4a-20d3-7c3b-ae8c-3db8540fbccd',
    pageToken: search.body.nextPageToken,
  }), (error) => error.status === 400);
  clock = new Date('2026-08-19T08:00:02Z');
  await assert.rejects(service.getSearchPage({
    owner, sessionId: search.body.sessionId, pageToken: search.body.nextPageToken,
  }), (error) => error.status === 410);
  await assert.rejects(service.createSearchSession({
    owner, requestKey: 'expiring-search',
    body: { latitude: 1, longitude: 1, radiusMeters: 1000, pageSize: 1 },
  }), (error) => error.status === 410);
});

test('the active geography predicate can use the declared partial GiST index', async () => {
  await createPlace({ name: 'Indexed Cafe', category: 'coffee', latitude: 1, longitude: 1 });
  const client = await pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const plan = await client.query(`
      EXPLAIN (FORMAT JSON)
      SELECT place_id FROM places
      WHERE state = 'active'
        AND ST_DWithin(
          location,
          ST_SetSRID(ST_Point(1, 1), 4326)::geography,
          1000,
          true
        )
    `);
    assert.match(JSON.stringify(plan.rows[0]), /places_active_location_gist/);
  } finally {
    client.release();
  }
  const stats = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM places WHERE state = 'active') AS active_places,
      (SELECT count(*)::int FROM place_versions) AS versions,
      (SELECT committed_revision::int FROM catalog_state WHERE singleton) AS revision
  `);
  assert.deepEqual(stats.rows[0], { active_places: 1, versions: 1, revision: 1 });
});
