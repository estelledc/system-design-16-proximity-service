# ADR 0001: PostGIS authority and materialized search sessions

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The fixed chapter correctly identifies geohash boundary issues and compares fixed grids, quadtrees, and S2-style cells. Its final
flow still lacks an exact radius predicate, bounded dense-cell behavior, an atomic join between cached cell membership and place
details, and a page snapshot under concurrent moves/closes.

The lab needs one runnable slice that can prove those joins without pretending to implement a global distributed map index. A
custom geohash neighbor algorithm would first need a global covering proof; a Redis cache would add an invalidation protocol before
the authoritative mutation/search semantics exist.

## Decision

### 1. PostgreSQL plus PostGIS is the current catalog and spatial authority

`places` holds one current bounded synthetic record with a `geography(Point,4326)` location, lifecycle, immutable version ID, and
catalog revision. A GiST index accelerates current active-place filtering. `place_versions` retains immutable before/after history.

Every successful create/update/delete transaction locks the single catalog row first and the place row second, then commits:

- stable mutation-key/request-digest binding and exact result;
- new immutable place version or tombstone;
- current name/category/location/lifecycle/version;
- catalog revision increment by exactly one.

One global catalog row is an intentional correctness bottleneck for this lab, not a production sharding design.

### 2. Geography distance is the acceptance/ranking contract

Coordinates are named latitude/longitude inputs but are constructed as `ST_Point(longitude, latitude, 4326)::geography`.
`ST_DWithin(location, query, radius_meters, true)` is the inclusive membership predicate and can use the GiST bounding-box
prefilter. `ST_Distance(location, query, true)` is rounded to integer millimeters and sorted with stable place ID.

The index may overselect internally. No geohash/S2 cell, prefix, bounding box, or cache membership is exposed as the exact answer.

### 3. A search session materializes one transaction snapshot

The initial authenticated request has a stable idempotency key and exact intent digest. In a Repeatable Read transaction, the
repository reads the catalog revision and selects active/category matches within radius in total order with `LIMIT 501`.

- Zero to 500 matches are copied into immutable `search_session_results` with the place/version/name/category/distance snapshot.
- A 501st match aborts with an explicit density-limit result; the API never silently truncates a supposedly complete radius set.
- `search_sessions` stores owner, request digest/key, snapshot revision, page size, count, and bounded expiry—but no raw query
  coordinates.
- Exact search replay returns the same session and first-page result even if the catalog later changes.

Later pages read only materialized rows by ordinal. This spends storage/write work to avoid a long database transaction and to make
page behavior directly testable.

### 4. Page tokens contain continuation authority, not query coordinates

Canonical JSON plus HMAC-SHA-256 binds token version, owner fingerprint, session ID, and next ordinal. Token bytes, owner, purpose,
session lifecycle, and ordinal bounds are revalidated. The raw location, category, radius, and result identities are absent.

The session's fixed page size and result count determine page boundaries. Intermediate pages return only `nextPageToken`; the
final page returns no continuation. Expired sessions return `410` and are not silently re-executed against a newer catalog.

### 5. Version preconditions and response-loss receipts are durable

Create, update/delete, and search-session creation each bind a stable key to immutable intent. Update/delete require exactly one
strong version ETag. A stale mutation records `precondition_failed`, consumes no catalog revision, and returns the current ETag.

The true-process smoke will kill the API after a successful search-session commit but before response bytes. Restart plus exact
key replay must recover the same session, snapshot revision, ordering, and page 1.

### 6. Evidence stops at the server boundary

Allowed labels include `catalog_mutation_committed`, `precondition_failed`, `search_session_committed`, `search_response`, and
`server_bytes_written`. Logs expose only operation/status/count/latency/evidence fields.

No event may claim client receipt, map rendering, route feasibility, physical proximity in the road network, a place visit,
ranking quality, catalog real-world accuracy, human satisfaction, or production acceptance.

## Consequences

### Positive

- Cell boundaries, antimeridian behavior, spheroid distance, and index prefilter stay behind one official geography contract.
- Place location/details/lifecycle and their spatial index update atomically instead of crossing a cache-sync window.
- Response-loss replay and stale mutation behavior are deterministic.
- Pagination cannot duplicate/skip because of a later move/close; it reads immutable session rows.
- Dense-result amplification fails explicitly before a partial result is published.
- Raw query coordinates are transient SQL parameters and are not stored in sessions/tokens/logs.

### Costs and limits

- Search creates database writes and up to 500 copied result rows; popular identical queries are not shared.
- One global catalog lock and one PostgreSQL/PostGIS instance are scaling bottlenecks.
- `LIMIT 501` bounds returned/materialized rows, not all internal index work; statement timeout and admission control remain needed.
- Millimeter rounding is a deterministic lab ordering key, not a sensor-accuracy claim.
- Query digests are data minimization, not anonymization; a small coordinate/category domain can be guessed offline.
- Expiry cleanup, idempotency retention, HMAC rotation, replica reads, caches, and distributed spatial partitions are absent.

## Rejected alternatives

### Center geohash plus eight neighbors

Rejected because the fixed radius/precision table has no completeness proof over latitude, boundary position, antimeridian, and all
supported radii. A correct covering plus exact predicate may be revisited with S2/H3 or a proven geohash enumeration.

### Redis geohash and details caches as the source of search

Rejected because a move/delete must update ID membership and detail value under one visible version. Building that invalidation and
reconciliation protocol is a separate experiment, and the controlled Redis documentation fetch was not valid evidence here.

### In-memory quadtree on every API startup

Rejected because build completion is not a shared catalog version or atomic publication protocol. Per-instance startup trees can
serve different revisions and make response-loss/page behavior untestable without another distribution layer.

### Live keyset pagination over current places

Rejected because a concurrent move, close, or distance change can cross the continuation key and cause a duplicate/skip. Retained
version history could support as-of queries, but bounded session materialization is smaller for v0.1.
