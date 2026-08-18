import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, listen, closeServer } from '../../src/http.js';
import { AppError } from '../../src/errors.js';

const authSecret = 'auth-fingerprint-secret-at-least-thirty-two-bytes';
const placeId = '018f5e4a-20d3-7c3b-ae8c-3db8540fbccd';
const versionId = '018f5e4a-20d3-7c3b-ae8c-3db8540fbccc';

async function fixture(overrides = {}) {
  const calls = [];
  const service = {
    async createPlace(args) {
      calls.push(args);
      return {
        body: { placeId, versionId, replayed: false },
        etag: `\"pv:${versionId}\"`,
        created: true,
      };
    },
    ...overrides,
  };
  const logs = [];
  const server = createHttpServer({ service, authSecret, logger: (line) => logs.push(line) });
  const { origin } = await listen(server);
  return { calls, logs, origin, server };
}

test('health is public while application routes require bearer authentication', async (t) => {
  const app = await fixture();
  t.after(() => closeServer(app.server));
  const health = await fetch(`${app.origin}/healthz`);
  assert.equal(health.status, 200);
  const denied = await fetch(`${app.origin}/v1/places`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'unauthorized');
});

test('create route returns private JSON, strong ETag, and no sensitive log fields', async (t) => {
  const app = await fixture();
  t.after(() => closeServer(app.server));
  const token = 'synthetic-owner-token';
  const key = 'synthetic-create-key';
  const name = 'Private Fixture Name';
  const response = await fetch(`${app.origin}/v1/places`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({ name, category: 'coffee', latitude: 1, longitude: 2 }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('etag'), `\"pv:${versionId}\"`);
  assert.equal(app.calls[0].owner.length, 64);
  await new Promise((resolve) => setImmediate(resolve));
  const logText = app.logs.join('\n');
  for (const secret of [token, key, name, placeId, versionId, 'latitude', 'longitude']) {
    assert.equal(logText.includes(secret), false);
  }
  assert.match(logText, /server_bytes_written/);
});

test('safe application errors retain status and ETag without leaking internals', async (t) => {
  const app = await fixture({
    async createPlace() {
      throw new AppError('precondition_failed', 412, 'the supplied place version is stale', {
        etag: `\"pv:${versionId}\"`,
      });
    },
  });
  t.after(() => closeServer(app.server));
  const response = await fetch(`${app.origin}/v1/places`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer synthetic-owner-token',
      'content-type': 'application/json',
      'idempotency-key': 'synthetic-create-key',
    },
    body: '{}',
  });
  assert.equal(response.status, 412);
  assert.equal(response.headers.get('etag'), `\"pv:${versionId}\"`);
  assert.deepEqual(await response.json(), {
    error: { code: 'precondition_failed', message: 'the supplied place version is stale' },
  });
});
