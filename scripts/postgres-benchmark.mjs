import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { intentDigest, ownerFingerprint } from '../src/crypto.js';
import { initializeDatabase, ProximityRepository, resetDatabase } from '../src/repository.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the bounded benchmark');

const pool = new Pool({ connectionString: databaseUrl, max: 8, statement_timeout: 15_000 });
const owner = ownerFingerprint(
  'benchmark-synthetic-owner',
  'benchmark-auth-secret-more-than-thirty-two-bytes',
);

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

try {
  await initializeDatabase(pool);
  await resetDatabase(pool, 'proximity-lab-reset');
  const seedStarted = performance.now();
  await pool.query(`
    INSERT INTO places (
      place_id, owner_fingerprint, name, category, latitude, longitude, location, state,
      version_id, version_number, committed_revision, created_at, updated_at
    )
    SELECT
      md5('place-' || g)::uuid,
      $1,
      'Synthetic Place ' || g,
      CASE WHEN g % 2 = 0 THEN 'coffee' ELSE 'library' END,
      25 + (g % 500) * 0.05,
      -124 + ((g / 500)::int % 100) * 0.57,
      ST_SetSRID(ST_Point(
        -124 + ((g / 500)::int % 100) * 0.57,
        25 + (g % 500) * 0.05
      ), 4326)::geography,
      'active',
      md5('version-' || g)::uuid,
      1,
      g,
      now(),
      now()
    FROM generate_series(1, 50000) AS g
  `, [owner]);
  await pool.query(`
    INSERT INTO place_versions (
      version_id, place_id, predecessor_version_id, version_number, owner_fingerprint,
      name, category, latitude, longitude, state, committed_revision, committed_at
    )
    SELECT
      version_id, place_id, NULL, version_number, owner_fingerprint,
      name, category, latitude, longitude, state, committed_revision, updated_at
    FROM places
  `);
  await pool.query(`UPDATE catalog_state SET committed_revision = 50000 WHERE singleton`);
  await pool.query('ANALYZE places');
  const seedMilliseconds = performance.now() - seedStarted;

  const repository = new ProximityRepository(pool);
  const latencies = [];
  const resultCounts = [];
  const samples = 200;
  const runStarted = performance.now();
  for (let index = 0; index < samples; index += 1) {
    const query = {
      latitude: 25 + ((index * 37) % 500) * 0.05,
      longitude: -124 + ((index * 17) % 100) * 0.57,
      radiusMeters: 50_000,
      pageSize: 100,
      category: index % 2 === 0 ? 'coffee' : 'library',
    };
    const requestKey = `benchmark-search-${index}`;
    const digest = intentDigest({ operation: 'search', owner, query });
    const started = performance.now();
    const session = await repository.createSearchSession({ owner, requestKey, digest, query });
    latencies.push(performance.now() - started);
    resultCounts.push(session.resultCount);
  }
  const totalMilliseconds = performance.now() - runStarted;
  latencies.sort((left, right) => left - right);
  const versions = await pool.query(`
    SELECT current_setting('server_version') AS postgres, postgis_lib_version() AS postgis
  `);
  process.stdout.write(`${JSON.stringify({
    evidence: 'bounded_synthetic_benchmark',
    runtime: process.version,
    postgres: versions.rows[0].postgres,
    postgis: versions.rows[0].postgis,
    fixture: {
      currentPlaces: 50_000,
      immutableVersions: 50_000,
      latitudeRange: [25, 49.95],
      longitudeRange: [-124, -67.57],
      alternatingCategories: ['coffee', 'library'],
      radiusMeters: 50_000,
      pageSize: 100,
      searchSessions: samples,
    },
    seedMilliseconds: Number(seedMilliseconds.toFixed(3)),
    sessionsPerSecond: Number((samples / (totalMilliseconds / 1000)).toFixed(3)),
    latencyMilliseconds: {
      p50: Number(percentile(latencies, 0.50).toFixed(3)),
      p95: Number(percentile(latencies, 0.95).toFixed(3)),
      maximum: Number(latencies.at(-1).toFixed(3)),
    },
    materializedRows: {
      total: resultCounts.reduce((sum, value) => sum + value, 0),
      maximumPerSession: Math.max(...resultCounts),
      densityLimit: 500,
    },
    productionCapacityClaim: false,
    networkLatencyIncluded: false,
    replicasIncluded: false,
  })}\n`);
} finally {
  await pool.end();
}
