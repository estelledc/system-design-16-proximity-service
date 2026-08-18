# Operations

## Local prerequisites

- Node.js 22, 24, or 26;
- npm with the committed lockfile;
- PostgreSQL 17 with PostGIS 3.5, or the pinned local Compose image.

Start the lab database:

```sh
docker compose up -d postgres
```

Install, test the pure layer, and run the authenticated server with development-only secrets:

```sh
npm ci --ignore-scripts
npm test
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/proximity \
AUTH_FINGERPRINT_SECRET='replace-with-at-least-32-bytes' \
PAGE_TOKEN_SECRET='replace-with-an-independent-32-byte-secret' \
npm start
```

The server creates idempotent v0.1 tables/extensions on startup. That convenience is for this disposable lab; a production system
would use reviewed, versioned, independently deployed migrations and restricted runtime database permissions.

## Gates

```sh
npm run check
npm run test:postgres
npm run smoke:postgres
npm run benchmark:postgres
npm run check:ci
```

- `check` is local/static: repository policy, 13+ pure tests, and high-severity dependency audit.
- `test:postgres` resets the configured lab tables and exercises real geography/transaction/query-plan behavior.
- `smoke:postgres` resets the lab, starts real server processes, forces `SIGKILL` after search commit, and checks exact replay/logs.
- `benchmark:postgres` resets the lab, inserts 50,000 deterministic synthetic rows/versions, then records 200 sequential sessions.
- `check:ci` is destructive to the configured `proximity` lab database. Never point it at shared or production data.

`resetDatabase` requires the literal in-code confirmation `proximity-lab-reset`, but that is an accident barrier rather than access
control. Use an isolated database identity and network for all test commands.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL/PostGIS connection; never log or commit it |
| `AUTH_FINGERPRINT_SECRET` | yes | HMAC key that pseudonymizes bearer tokens for owner scoping |
| `PAGE_TOKEN_SECRET` | yes | independent HMAC key for continuation integrity |
| `HOST` | no | listen host, default `127.0.0.1` |
| `PORT` | no | listen port, default `3000`; `0` chooses an ephemeral smoke port |
| `CRASH_AFTER_SEARCH_COMMIT` | smoke only | `1` kills the process before the first new-search response |

Secrets must be independently generated, at least 32 bytes, rotated through a versioned keyring in any real deployment, and kept
outside command history. v0.1 intentionally has no key rotation or old-token grace protocol.

## Observable facts

Each line is JSON with only:

- `operation`;
- HTTP `status`;
- bounded `count` for a search page/session;
- rounded `elapsedMs`;
- evidence such as `search_session_committed`, `precondition_failed`, `request_rejected`, or `server_bytes_written`.

Do not add raw coordinates, place/session/version identity, names, auth/request keys, digests, page tokens, request/response bodies,
or database URLs. `server_bytes_written` means the HTTP server completed its write callback; it does not prove remote receipt.

## Incident checks

### Unexpected stale writes

1. Count `precondition_failed` receipts and applied mutations separately.
2. Check current version number and catalog revision without copying place contents into tickets/logs.
3. Confirm clients use the exact ETag returned by their prior owner-scoped read.
4. Never delete a stale receipt to make a retry “work”; use a new key after deliberately reading the new base.

### Search inconsistency report

1. Identify the session through an access-controlled support channel; do not paste its token into ordinary logs.
2. Compare immutable result ordinals/version IDs with current catalog versions. They are expected to differ after later writes.
3. Recompute against the recorded `snapshotRevision` only if an as-of audit store exists; v0.1 retains versions but has no full
   as-of query implementation.
4. Treat current-search differences as evidence only after checking category, radius, exact coordinate, expiry, and revision.

### Dense-result failures

`density_limit_exceeded` protects completeness and write amplification. It is not a transient database error. A product decision is
required before changing the radius, filters, maximum, or partial-result semantics.

## Missing production operations

No automatic expiry cleanup, mutation-receipt retention, backup/restore, failover, replicas, connection proxy, online schema
migration, rate limit, quota, abuse defense, tenant provisioning, erasure workflow, SLO, paging policy, or disaster recovery is
implemented. Public CI validates a disposable single-node laboratory only.
