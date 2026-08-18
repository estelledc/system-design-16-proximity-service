import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { initializeDatabase, resetDatabase } from '../src/repository.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the process smoke');

const authToken = 'smoke-owner-token-private';
const authSecret = 'smoke-auth-fingerprint-secret-more-than-thirty-two-bytes';
const pageSecret = 'smoke-page-token-secret-more-than-thirty-two-bytes';
const coordinates = { latitude: 37.7749, longitude: -122.4194 };
const requestKeys = {
  first: 'smoke-create-first',
  second: 'smoke-create-second',
  third: 'smoke-create-third',
  frozen: 'smoke-search-response-loss',
  move: 'smoke-move-third',
  close: 'smoke-close-first',
  current: 'smoke-search-current',
};
const names = ['Smoke First Cafe', 'Smoke Second Cafe', 'Smoke Third Cafe'];
const allProcessLogs = [];

function headers(key, etag) {
  return {
    authorization: `Bearer ${authToken}`,
    'content-type': 'application/json',
    ...(key ? { 'idempotency-key': key } : {}),
    ...(etag ? { 'if-match': etag } : {}),
  };
}

async function jsonRequest(origin, path, { method = 'GET', key, etag, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: headers(key, etag),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path} failed: ${response.status} ${JSON.stringify(value)}`);
  return { status: response.status, body: value, etag: response.headers.get('etag') };
}

async function startServer({ crash = false } = {}) {
  const child = spawn(process.execPath, ['src/main.js', 'serve'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: '0',
      AUTH_FINGERPRINT_SECRET: authSecret,
      PAGE_TOKEN_SECRET: pageSecret,
      CRASH_AFTER_SEARCH_COMMIT: crash ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const consume = (chunk) => {
      const text = chunk.toString('utf8');
      allProcessLogs.push(text);
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (!settled && event.operation === 'server_ready') {
            settled = true;
            resolve(`http://127.0.0.1:${event.port}`);
          }
        } catch {
          // Non-JSON startup failures are handled by the exit event.
        }
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`server exited before ready: code=${code} signal=${signal}`));
      }
    });
  });
  const origin = await Promise.race([
    ready,
    delay(10_000).then(() => { throw new Error('server readiness timed out'); }),
  ]);
  return { child, origin };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      child.kill('SIGKILL');
      throw new Error('server did not stop within five seconds');
    }),
  ]);
}

const pool = new Pool({ connectionString: databaseUrl });
let normal;
let crashing;
let restarted;
try {
  await initializeDatabase(pool);
  await resetDatabase(pool, 'proximity-lab-reset');

  normal = await startServer();
  const first = await jsonRequest(normal.origin, '/v1/places', {
    method: 'POST', key: requestKeys.first,
    body: { name: names[0], category: 'coffee', ...coordinates },
  });
  const second = await jsonRequest(normal.origin, '/v1/places', {
    method: 'POST', key: requestKeys.second,
    body: { name: names[1], category: 'coffee', latitude: 37.7749, longitude: -122.4184 },
  });
  const third = await jsonRequest(normal.origin, '/v1/places', {
    method: 'POST', key: requestKeys.third,
    body: { name: names[2], category: 'coffee', latitude: 37.7749, longitude: -122.4094 },
  });
  await stopServer(normal.child);
  normal = null;

  crashing = await startServer({ crash: true });
  let responseLost = false;
  try {
    await fetch(`${crashing.origin}/v1/search-sessions`, {
      method: 'POST',
      headers: headers(requestKeys.frozen),
      body: JSON.stringify({ ...coordinates, radiusMeters: 2000, pageSize: 2, category: 'coffee' }),
    });
  } catch {
    responseLost = true;
  }
  assert.equal(responseLost, true, 'crash hook must drop the response');
  if (crashing.child.exitCode === null && crashing.child.signalCode === null) {
    await new Promise((resolve) => crashing.child.once('exit', resolve));
  }
  assert.equal(crashing.child.signalCode, 'SIGKILL');
  const committed = await pool.query(`
    SELECT s.session_id, s.snapshot_revision::int, s.result_count,
      array_agg(r.place_id ORDER BY r.ordinal) AS result_ids
    FROM search_sessions s
    JOIN search_session_results r USING (session_id)
    WHERE s.request_key = $1
    GROUP BY s.session_id, s.snapshot_revision, s.result_count
  `, [requestKeys.frozen]);
  assert.equal(committed.rowCount, 1);
  assert.equal(committed.rows[0].snapshot_revision, 3);
  assert.equal(committed.rows[0].result_count, 3);
  crashing = null;

  restarted = await startServer();
  const replay = await jsonRequest(restarted.origin, '/v1/search-sessions', {
    method: 'POST', key: requestKeys.frozen,
    body: { ...coordinates, radiusMeters: 2000, pageSize: 2, category: 'coffee' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.sessionId, committed.rows[0].session_id);
  assert.equal(replay.body.snapshotRevision, 3);
  assert.deepEqual(replay.body.items.map((item) => item.placeId), committed.rows[0].result_ids.slice(0, 2));

  await jsonRequest(restarted.origin, `/v1/places/${third.body.placeId}`, {
    method: 'PUT', key: requestKeys.move, etag: third.etag,
    body: { name: names[2], category: 'coffee', latitude: 40, longitude: -120, state: 'active' },
  });
  await jsonRequest(restarted.origin, `/v1/places/${first.body.placeId}`, {
    method: 'PUT', key: requestKeys.close, etag: first.etag,
    body: { name: names[0], category: 'coffee', ...coordinates, state: 'closed' },
  });

  const oldPage = await jsonRequest(
    restarted.origin,
    `/v1/search-sessions/${replay.body.sessionId}?pageToken=${encodeURIComponent(replay.body.nextPageToken)}`,
  );
  assert.deepEqual(oldPage.body.items.map((item) => item.placeId), [third.body.placeId]);
  assert.equal(oldPage.body.items[0].longitude, -122.4094);

  const current = await jsonRequest(restarted.origin, '/v1/search-sessions', {
    method: 'POST', key: requestKeys.current,
    body: { ...coordinates, radiusMeters: 2000, pageSize: 2, category: 'coffee' },
  });
  assert.deepEqual(current.body.items.map((item) => item.placeId), [second.body.placeId]);
  assert.equal(current.body.snapshotRevision, 5);

  const stats = await pool.query(`
    SELECT
      (SELECT committed_revision::int FROM catalog_state WHERE singleton) AS revisions,
      (SELECT count(*)::int FROM places WHERE state = 'active') AS active_places,
      (SELECT count(*)::int FROM places WHERE state = 'closed') AS closed_places,
      (SELECT count(*)::int FROM place_versions) AS versions,
      (SELECT count(*)::int FROM mutation_requests) AS mutations,
      (SELECT count(*)::int FROM search_sessions) AS sessions,
      (SELECT count(*)::int FROM search_session_results) AS results
  `);
  assert.deepEqual(stats.rows[0], {
    revisions: 5,
    active_places: 2,
    closed_places: 1,
    versions: 5,
    mutations: 5,
    sessions: 2,
    results: 4,
  });

  await delay(50);
  const logText = allProcessLogs.join('');
  const forbidden = [
    authToken, authSecret, pageSecret, ...Object.values(requestKeys), ...names,
    String(coordinates.latitude), String(coordinates.longitude),
    first.body.placeId, second.body.placeId, third.body.placeId,
    first.body.versionId, second.body.versionId, third.body.versionId,
    replay.body.sessionId, replay.body.nextPageToken,
  ];
  for (const value of forbidden) assert.equal(logText.includes(value), false, `log leaked forbidden value: ${value}`);
  assert.match(logText, /search_session_committed/);

  process.stdout.write(`${JSON.stringify({
    evidence: 'bounded_process_smoke',
    responseLossRecovered: true,
    crashSignal: 'SIGKILL',
    replayedSameSession: true,
    frozenPageRetainedPriorPlaceVersion: true,
    currentSearchObservedRevision: 5,
    catalog: stats.rows[0],
    logLeakMatches: 0,
    clientReceiptClaims: 0,
    mapRenderClaims: 0,
    visitClaims: 0,
    humanOutcomeClaims: 0,
  })}\n`);
} finally {
  if (normal) await stopServer(normal.child).catch(() => {});
  if (crashing) await stopServer(crashing.child).catch(() => {});
  if (restarted) await stopServer(restarted.child).catch(() => {});
  await pool.end();
}
