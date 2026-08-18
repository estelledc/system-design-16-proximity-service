# Architecture

## Smallest complete slice

```text
authenticated HTTP request
        |
        v
strict contract + intent digest + owner fingerprint
        |
        v
PostgreSQL 17 / PostGIS 3.5
  - current places + partial GiST geography index
  - immutable place versions + mutation receipts
  - catalog revision
  - materialized search sessions + ordered result copies
        |
        v
private/no-store JSON response + sanitized aggregate log
```

There is no Redis, asynchronous indexer, geohash lookup, replica, or background publisher. That omission is deliberate: current
metadata, lifecycle, location, and spatial-index membership remain one transactional fact while the mutation and page semantics are
being proved.

## Catalog write path

Every create/update/delete transaction uses this lock order:

1. look for an existing `(owner fingerprint, idempotency key)` receipt;
2. lock the singleton catalog row;
3. look for the receipt again after a competing commit;
4. for update/delete, lock the owner-scoped place row and compare the strong base version;
5. either persist a stale receipt with no revision, or increment the revision and write the new current/version/receipt rows;
6. commit before producing a response.

The second receipt lookup closes the race in which two exact retries both see an absent key before the catalog lock. The global lock
also gives one unambiguous revision order. It is not a claim that one lock could sustain the hypothetical workload.

## Search-session path

The initial request runs in PostgreSQL Repeatable Read:

1. recover an existing exact-key session if one exists;
2. read the catalog revision in the transaction snapshot;
3. construct `ST_Point(longitude, latitude, 4326)::geography`;
4. filter current `active` rows with optional exact category and inclusive `ST_DWithin`;
5. rank with rounded millimeter `ST_Distance`, then UUID, and request 501 rows;
6. reject 501 rows, otherwise persist the session plus every result copy and commit.

Before opening the Repeatable Read transaction, the connection takes a session-level advisory lock derived from owner plus request
key. That lock does not establish a transaction snapshot; a waiting exact retry therefore begins after the winner commits and sees
its session without an expected unique-constraint error exposing the key in database error logs. PostgreSQL releases the lock if
the connection/process dies. The named unique constraint remains a final integrity backstop, and a PostgreSQL `40001`
serialization failure gets one bounded transaction retry. No HTTP page holds a database snapshot open.

## Pagination state

Session rows contain owner fingerprint, request key/digest, snapshot revision, page size/count, and timestamps. They intentionally
do not contain raw query coordinates. Result rows contain the exact immutable response copy: place/version, bounded name/category,
coordinates, and integer-millimeter distance.

The opaque continuation is canonical JSON plus HMAC-SHA-256:

```json
{"next":2,"owner":"<fingerprint>","session":"<uuid>","v":1}
```

It contains no query location or result identity. The server rechecks signature, exact shape, token version, owner, route session,
ordinal alignment, result count, and expiry before reading one ordinal range.

## Geometry semantics

- JSON uses named latitude/longitude; SQL point construction uses longitude as X and latitude as Y.
- `+180` canonicalizes to `-180`; signed zero canonicalizes to zero.
- PostGIS `geography(Point,4326)` supplies antimeridian/polar behavior and spheroid meters.
- The GiST index may overselect a bounding box internally. `ST_DWithin` remains the final inclusive circle predicate.
- Millimeter rounding makes order deterministic; it does not claim millimeter location accuracy.

## Failure behavior

| Failure | Committed state | Retry behavior |
|---|---|---|
| process dies before mutation/search commit | none | request may execute normally |
| mutation commits, response is lost | current/version/receipt/revision | exact key returns the recorded result |
| search commits, response is lost | session and every copied result | exact key returns the same session/page 1 |
| two updates use one base version | one new version; one stale receipt | each key keeps its original applied/stale outcome |
| two initial searches use one exact key | one unique session | loser reads the winner after rollback |
| catalog changes between pages | new current catalog only | old session pages remain unchanged |
| result count reaches 501 | no search session | explicit bounded error; no completeness claim |
