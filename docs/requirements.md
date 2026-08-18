# Requirements and acceptance boundary

## Product slice

The lab has two authenticated actors, represented only by synthetic bearer tokens:

- a place operator creates, replaces, closes, or tombstones one bounded place record;
- a searcher opens an exact radius/category search session and follows its immutable pages.

The service returns server-side catalog/search facts. It does not provide geocoding, map display, road distance, navigation,
opening hours, recommendations, real business data, or proof that a remote client received or acted on a response.

## Functional requirements

| ID | Requirement | Observable acceptance |
|---|---|---|
| R1 | Accept only finite named coordinates, a 1–50,000 m integer radius, a 1–100 page size, and exact portable category | malformed, unknown, NaN/infinite, wrapped, or oversized input fails before SQL |
| R2 | Create one current active place and immutable version atomically | current row, version row, mutation receipt, and catalog revision commit together |
| R3 | Replace or tombstone only the exact strong base version | two writes from one ETag yield one applied mutation and one durable `412`; stale write consumes no revision |
| R4 | Make mutation and initial-search retries intent-stable | exact key replay returns the original IDs/revision/session; changed intent returns `409` |
| R5 | Use one exact global predicate over WGS 84 geography | `ST_DWithin(..., true)` decides inclusion in meters; antimeridian and polar fixtures pass |
| R6 | Return a deterministic total order | integer-millimeter `ST_Distance(..., true)` then place UUID orders every accepted row |
| R7 | Freeze one page chain | initial search copies at most 500 ordered result versions inside one Repeatable Read transaction |
| R8 | Bind continuation authority | HMAC token binds version, owner fingerprint, session UUID, and next ordinal; route/owner/tamper/expiry fail closed |
| R9 | Bound dense-result publication | 501 exact matches return `density_limit_exceeded`; no partial session is committed |
| R10 | Minimize operational evidence | logs contain operation/status/count/latency/evidence only, not coordinates, names, IDs, keys, digests, tokens, or results |

## Consistency contract

- One `catalog_state` row serializes catalog revisions. This is an intentional lab bottleneck.
- A successful mutation increments the revision exactly once. A stale precondition does not increment it.
- `places`, its partial GiST membership, and the immutable `place_versions` row share one PostgreSQL transaction.
- A search session's `snapshotRevision` is the catalog revision visible in its Repeatable Read snapshot.
- Later catalog changes do not rewrite copied session rows. A new search can see the later revision.
- Search expiry is terminal. The service does not silently rerun an expired key against a new catalog.

## Work and storage bounds

- JSON request body: 16 KiB.
- Idempotency key: 128 portable characters.
- Page token: 1,024 URL characters.
- Exact materialized results: 500 per session.
- Page size: 100.
- Session lifetime: 30 minutes in the runnable server.
- PostgreSQL statement timeout: 5 seconds in the runnable server.

`LIMIT 501` bounds rows returned to the application; it does not prove that PostGIS examined at most 501 internal candidates.
Admission control, quotas, retention cleanup, and production resource limits remain out of scope.

## Quality gates

Completion requires all of the following on the same public commit:

1. repository policy/static checks, unit tests, and a high-severity dependency audit;
2. real PostgreSQL 17/PostGIS 3.5 tests, with zero skips, on Node.js 22, 24, and 26;
3. a true-process `SIGKILL` after search commit but before HTTP response, followed by exact-key recovery;
4. a bounded 50,000-row synthetic benchmark whose raw fixture/runtime/results are reported without an SLA or capacity claim;
5. a clean worktree, public MIT repository, protected evidence vocabulary, and exact CI receipt.
