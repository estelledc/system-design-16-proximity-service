import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { conflict, densityLimit, gone, notFound } from './errors.js';

const schemaUrl = new URL('../sql/schema.sql', import.meta.url);

function number(value) {
  return Number.parseInt(value, 10);
}

function placeFromRow(row) {
  return {
    placeId: row.place_id,
    name: row.name,
    category: row.category,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    state: row.state,
    versionId: row.version_id,
    versionNumber: row.version_number,
    catalogRevision: number(row.committed_revision),
  };
}

function mutationFromRow(row, replayed) {
  return {
    outcome: row.outcome,
    operation: row.operation,
    placeId: row.place_id,
    versionId: row.result_version_id,
    versionNumber: row.result_version_number,
    catalogRevision: row.result_revision === null ? null : number(row.result_revision),
    replayed,
  };
}

function sessionFromRow(row, replayed) {
  return {
    sessionId: row.session_id,
    snapshotRevision: number(row.snapshot_revision),
    pageSize: row.page_size,
    resultCount: row.result_count,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    replayed,
  };
}

async function rollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

export async function initializeDatabase(pool) {
  const sql = await readFile(fileURLToPath(schemaUrl), 'utf8');
  await pool.query(sql);
}

export async function resetDatabase(pool, confirmation) {
  if (confirmation !== 'proximity-lab-reset') {
    throw new Error('refusing to reset without the explicit lab confirmation');
  }
  await pool.query(`
    TRUNCATE search_session_results, search_sessions, mutation_requests, place_versions, places CASCADE;
    UPDATE catalog_state SET committed_revision = 0 WHERE singleton = true;
  `);
}

export class ProximityRepository {
  constructor(pool, { now = () => new Date(), sessionTtlMs = 30 * 60 * 1_000 } = {}) {
    this.pool = pool;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
  }

  async #existingMutation(client, owner, requestKey, digest) {
    const result = await client.query(
      `SELECT * FROM mutation_requests WHERE owner_fingerprint = $1 AND request_key = $2`,
      [owner, requestKey],
    );
    if (!result.rowCount) return null;
    if (result.rows[0].intent_digest !== digest) {
      throw conflict('this idempotency key is already bound to a different mutation intent');
    }
    return mutationFromRow(result.rows[0], true);
  }

  async #lockCatalog(client) {
    await client.query(`SELECT committed_revision FROM catalog_state WHERE singleton = true FOR UPDATE`);
  }

  async #nextRevision(client) {
    const result = await client.query(`
      UPDATE catalog_state
      SET committed_revision = committed_revision + 1
      WHERE singleton = true
      RETURNING committed_revision
    `);
    return number(result.rows[0].committed_revision);
  }

  async createPlace({ owner, requestKey, digest, input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingMutation(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockCatalog(client);
      existing = await this.#existingMutation(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }

      const now = this.now();
      const placeId = randomUUID();
      const versionId = randomUUID();
      const revision = await this.#nextRevision(client);
      await client.query(`
        INSERT INTO places (
          place_id, owner_fingerprint, name, category, latitude, longitude, location, state,
          version_id, version_number, committed_revision, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          ST_SetSRID(ST_Point($6, $5), 4326)::geography,
          'active', $7, 1, $8, $9, $9
        )
      `, [placeId, owner, input.name, input.category, input.latitude, input.longitude, versionId, revision, now]);
      await client.query(`
        INSERT INTO place_versions (
          version_id, place_id, predecessor_version_id, version_number, owner_fingerprint,
          name, category, latitude, longitude, state, committed_revision, committed_at
        ) VALUES ($1, $2, NULL, 1, $3, $4, $5, $6, $7, 'active', $8, $9)
      `, [versionId, placeId, owner, input.name, input.category, input.latitude, input.longitude, revision, now]);
      await client.query(`
        INSERT INTO mutation_requests (
          owner_fingerprint, request_key, intent_digest, operation, outcome, place_id,
          result_version_id, result_version_number, result_revision, created_at
        ) VALUES ($1, $2, $3, 'create', 'applied', $4, $5, 1, $6, $7)
      `, [owner, requestKey, digest, placeId, versionId, revision, now]);
      await client.query('COMMIT');
      return {
        outcome: 'applied', operation: 'create', placeId, versionId, versionNumber: 1,
        catalogRevision: revision, replayed: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #changePlace({ owner, requestKey, digest, placeId, baseVersionId, operation, input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let existing = await this.#existingMutation(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      await this.#lockCatalog(client);
      existing = await this.#existingMutation(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const selected = await client.query(
        `SELECT * FROM places WHERE place_id = $1 AND owner_fingerprint = $2 FOR UPDATE`,
        [placeId, owner],
      );
      if (!selected.rowCount) throw notFound();
      const current = selected.rows[0];
      if (current.state === 'tombstoned') throw gone();
      const now = this.now();
      if (current.version_id !== baseVersionId) {
        await client.query(`
          INSERT INTO mutation_requests (
            owner_fingerprint, request_key, intent_digest, operation, outcome, place_id,
            result_version_id, result_version_number, result_revision, created_at
          ) VALUES ($1, $2, $3, $4, 'precondition_failed', $5, $6, $7, NULL, $8)
        `, [owner, requestKey, digest, operation, placeId, current.version_id, current.version_number, now]);
        await client.query('COMMIT');
        return {
          outcome: 'precondition_failed', operation, placeId,
          versionId: current.version_id, versionNumber: current.version_number,
          catalogRevision: null, replayed: false,
        };
      }

      const next = operation === 'delete'
        ? {
            name: current.name,
            category: current.category,
            latitude: Number(current.latitude),
            longitude: Number(current.longitude),
            state: 'tombstoned',
          }
        : input;
      const versionId = randomUUID();
      const versionNumber = current.version_number + 1;
      const revision = await this.#nextRevision(client);
      await client.query(`
        INSERT INTO place_versions (
          version_id, place_id, predecessor_version_id, version_number, owner_fingerprint,
          name, category, latitude, longitude, state, committed_revision, committed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        versionId, placeId, current.version_id, versionNumber, owner,
        next.name, next.category, next.latitude, next.longitude, next.state, revision, now,
      ]);
      await client.query(`
        UPDATE places SET
          name = $2, category = $3, latitude = $4, longitude = $5,
          location = ST_SetSRID(ST_Point($5, $4), 4326)::geography,
          state = $6, version_id = $7, version_number = $8,
          committed_revision = $9, updated_at = $10
        WHERE place_id = $1
      `, [
        placeId, next.name, next.category, next.latitude, next.longitude,
        next.state, versionId, versionNumber, revision, now,
      ]);
      await client.query(`
        INSERT INTO mutation_requests (
          owner_fingerprint, request_key, intent_digest, operation, outcome, place_id,
          result_version_id, result_version_number, result_revision, created_at
        ) VALUES ($1, $2, $3, $4, 'applied', $5, $6, $7, $8, $9)
      `, [owner, requestKey, digest, operation, placeId, versionId, versionNumber, revision, now]);
      await client.query('COMMIT');
      return {
        outcome: 'applied', operation, placeId, versionId, versionNumber,
        catalogRevision: revision, replayed: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  updatePlace(args) {
    return this.#changePlace({ ...args, operation: 'update' });
  }

  deletePlace(args) {
    return this.#changePlace({ ...args, operation: 'delete', input: undefined });
  }

  async getPlace({ owner, placeId }) {
    const result = await this.pool.query(
      `SELECT * FROM places WHERE place_id = $1 AND owner_fingerprint = $2`,
      [placeId, owner],
    );
    if (!result.rowCount) throw notFound();
    if (result.rows[0].state === 'tombstoned') throw gone();
    return placeFromRow(result.rows[0]);
  }

  async #existingSession(client, owner, requestKey, digest) {
    const result = await client.query(
      `SELECT * FROM search_sessions WHERE owner_fingerprint = $1 AND request_key = $2`,
      [owner, requestKey],
    );
    if (!result.rowCount) return null;
    if (result.rows[0].intent_digest !== digest) {
      throw conflict('this idempotency key is already bound to a different search intent');
    }
    if (new Date(result.rows[0].expires_at) <= this.now()) {
      throw gone('search session has expired');
    }
    return sessionFromRow(result.rows[0], true);
  }

  async #recoverConcurrentSession(owner, requestKey, digest) {
    const result = await this.pool.query(
      `SELECT * FROM search_sessions WHERE owner_fingerprint = $1 AND request_key = $2`,
      [owner, requestKey],
    );
    if (!result.rowCount) throw new Error('concurrent search session was not visible after unique conflict');
    const row = result.rows[0];
    if (row.intent_digest !== digest) {
      throw conflict('this idempotency key is already bound to a different search intent');
    }
    if (new Date(row.expires_at) <= this.now()) throw gone('search session has expired');
    return sessionFromRow(row, true);
  }

  async #createSearchAttempt({ owner, requestKey, digest, query }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const existing = await this.#existingSession(client, owner, requestKey, digest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const revisionResult = await client.query(
        `SELECT committed_revision FROM catalog_state WHERE singleton = true`,
      );
      const matches = await client.query(`
        WITH search_point AS (
          SELECT ST_SetSRID(ST_Point($1, $2), 4326)::geography AS location
        )
        SELECT
          p.place_id, p.version_id, p.name, p.category, p.latitude, p.longitude,
          round(ST_Distance(p.location, q.location, true) * 1000)::bigint AS distance_mm
        FROM places AS p
        CROSS JOIN search_point AS q
        WHERE p.state = 'active'
          AND ($4::text IS NULL OR p.category = $4)
          AND ST_DWithin(p.location, q.location, $3, true)
        ORDER BY distance_mm ASC, p.place_id ASC
        LIMIT 501
      `, [query.longitude, query.latitude, query.radiusMeters, query.category ?? null]);
      if (matches.rowCount > 500) throw densityLimit();

      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
      const sessionId = randomUUID();
      const snapshotRevision = number(revisionResult.rows[0].committed_revision);
      await client.query(`
        INSERT INTO search_sessions (
          session_id, owner_fingerprint, request_key, intent_digest, snapshot_revision,
          page_size, result_count, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        sessionId, owner, requestKey, digest, snapshotRevision,
        query.pageSize, matches.rowCount, now, expiresAt,
      ]);
      if (matches.rowCount) {
        const values = matches.rows.flatMap((row, ordinal) => [
          sessionId, ordinal, row.place_id, row.version_id, row.name, row.category,
          row.latitude, row.longitude, row.distance_mm,
        ]);
        const tuples = matches.rows.map((_, index) => {
          const base = index * 9;
          return `(${Array.from({ length: 9 }, (_unused, offset) => `$${base + offset + 1}`).join(',')})`;
        }).join(',');
        await client.query(`
          INSERT INTO search_session_results (
            session_id, ordinal, place_id, version_id, name, category,
            latitude, longitude, distance_mm
          ) VALUES ${tuples}
        `, values);
      }
      await client.query('COMMIT');
      return {
        sessionId, snapshotRevision, pageSize: query.pageSize,
        resultCount: matches.rowCount, createdAt: now, expiresAt, replayed: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createSearchSession(args) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#createSearchAttempt(args);
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'search_sessions_owner_key_unique') {
          return this.#recoverConcurrentSession(args.owner, args.requestKey, args.digest);
        }
        if (error.code === '40001' && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error('unreachable search retry state');
  }

  async getSearchPage({ owner, sessionId, startOrdinal }) {
    const sessionResult = await this.pool.query(
      `SELECT * FROM search_sessions WHERE session_id = $1 AND owner_fingerprint = $2`,
      [sessionId, owner],
    );
    if (!sessionResult.rowCount) throw notFound();
    const row = sessionResult.rows[0];
    if (new Date(row.expires_at) <= this.now()) throw gone('search session has expired');
    if (
      !Number.isSafeInteger(startOrdinal)
      || startOrdinal < 0
      || (startOrdinal > 0 && (startOrdinal >= row.result_count || startOrdinal % row.page_size !== 0))
    ) {
      throw notFound();
    }
    const items = await this.pool.query(`
      SELECT ordinal, place_id, version_id, name, category, latitude, longitude, distance_mm
      FROM search_session_results
      WHERE session_id = $1 AND ordinal >= $2 AND ordinal < $3
      ORDER BY ordinal ASC
    `, [sessionId, startOrdinal, startOrdinal + row.page_size]);
    return {
      session: sessionFromRow(row, false),
      startOrdinal,
      items: items.rows.map((item) => ({
        placeId: item.place_id,
        versionId: item.version_id,
        name: item.name,
        category: item.category,
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
        distanceMillimeters: number(item.distance_mm),
      })),
    };
  }
}
