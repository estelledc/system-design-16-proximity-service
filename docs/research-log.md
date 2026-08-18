# Research log

## Evidence boundary

The secondary chapter is fixed at repository commit `9d8388721e7231442763ad37398b8d82224aa68f`, chapter tree
`86a8136ad6f7a7931de4aa122c80d119937d0757`, and `Readme.md` blob
`32b89829cf160212ff8a2e8970ddffd38e1ca3dc`. That tree has no detected license, so this repository contains only independent
analysis and implementation. It does not copy the chapter's prose, diagrams, images, data, or code.

Public standards and official project documentation are used to check mechanisms. They do not make the future implementation a
conforming Yelp, Google Maps, S2, Redis, PostGIS-hosting, or production location service.

## Closed-book comparison

| Question | Closed-book decision | Fixed chapter | Result for v0.1 |
|---|---|---|---|
| product slice | radius/category search, versioned place mutations, stable page session | nearby search, owner CRUD, detail read | keep the narrow search/mutation slice and omit detail/media/reviews |
| spatial predicate | index must be complete candidate generator; one exact documented distance decides inclusion | geohash length + center and eight neighbors, then sort by distance | use PostGIS geography/GiST plus `ST_DWithin`; do not implement an unproved nine-cell lookup |
| mutation consistency | strong base version and atomic metadata/index visibility | primary writes, replica reads, daily batch cache/index sync | keep PostgreSQL current row/index as one transaction; no asynchronous Redis copy |
| pagination | bind query, snapshot, total order, and continuation | no limit, page token, snapshot, tie-break, or density bound | materialize one bounded result session in a Repeatable Read transaction |
| density | explicit candidate/result/work ceiling with visible failure | fetch all IDs from nine Redis cells in parallel | accept at most 500 matches; 501st match returns a density-limit error, never silent truncation |
| privacy/evidence | precise query location and result identity stay out of logs; server result is not a visit | GDPR/CCPA named without data-flow controls | persist query digest but not raw query coordinates; keep server-only evidence labels |

## What the chapter contributes

- A latitude/longitude table scan and independent one-dimensional indexes do not express a useful two-dimensional access path.
- A spatial index narrows candidates; cell/grid boundaries require deliberate covering rather than a same-prefix lookup.
- Geohash/even grid favor simple incremental updates, while a quadtree can adapt cell sizes to density at the cost of build/update
  complexity.
- Spatial metadata and detailed place data have different read patterns and may be cached separately only with a consistency plan.
- Dense urban cells, startup builds, cache invalidation, read replicas, and regional deployment are operational concerns rather
  than geometry details.

These are useful directions. v0.1 uses the platform's spatial index to focus on the unclosed join between exact inclusion,
catalog mutation, response-loss replay, density bounds, and stable pagination.

## Defects and missing contracts in the fixed chapter

1. **The QPS arithmetic is low.** `100,000,000 × 5 / 86,400` is about 5,787 QPS, not 5,000. More importantly, no peak multiplier,
   detail-read ratio, write rate, cache miss, candidate fanout, storage, or bandwidth estimate follows.
2. **The naive SQL mixes units and shapes.** It subtracts a radius from degree coordinates without converting meters, latitude
   scaling, longitude convergence, or antimeridian wrapping. A bounding rectangle also needs an exact circular predicate.
3. **Database choice is not justified by read volume.** “Read-heavy” does not itself select a relational model. The chapter shows
   neither the business schema nor version/lifecycle, constraints, query plan, spatial index DDL, or transaction boundary.
4. **Replica staleness is dismissed, not bounded.** Business writes and LBS reads may disagree, but there is no maximum staleness,
   delete/close safety rule, version join, read-your-write option, or reconciliation receipt.
5. **The nine-geohash recipe has no covering proof.** A radius-to-length table plus center/eight neighbors is not shown complete for
   every center position, latitude-dependent cell width, antimeridian, poles, or the stated radius range.
6. **Candidate and final predicate are blurred.** The final flow fetches IDs from nine cells and sorts by distance, but never says
   that out-of-radius false positives are removed with one specified Earth model and inclusive boundary.
7. **Geohash proximity claims need directionality.** Nearby points can have unrelated prefixes across a boundary. A common prefix
   bounds points to a shared cell; it is not a globally monotonic distance ordering.
8. **Quadtree size/build claims are unevidenced.** “GBs” and “a few minutes” for 200 million businesses lack node layout, depth,
   distribution, build hardware, measurements, and availability definition.
9. **Quadtree update language contradicts itself.** “Incrementally rebuild,” whole-tree rebuild, and in-place locked update are
   distinct protocols. Startup construction on every LBS instance gives no catalog revision, publication gate, or cross-instance
   consistency.
10. **S2 is reduced to a Hilbert slogan.** A one-dimensional cell ID does not itself answer radius search. Real region covering has
    explicit min/max levels, cell budget, approximation error, and a separate exact-region check.
11. **The final cache join has no version.** The geohash cache maps to IDs and a second cache maps IDs to details, while a vague
    “Sync” arrow comes from replicas. A move/update can expose old-cell/new-details, new-cell/old-details, duplicates, or absence.
12. **Cache keys omit query semantics.** A geohash alone does not bind radius, category, lifecycle, ranking version, catalog
    snapshot, or pagination. GPS inaccuracy is a product uncertainty, not a reason that the cache is coherent.
13. **Dense-cell amplification is unbounded.** Nine parallel Redis reads can return arbitrarily many IDs, followed by detail fanout
    and full sorting. There is no maximum IDs, batch size, timeout, partial-result flag, or overload behavior.
14. **CRUD and daily batch conflict without a freshness contract.** The API allows add/update/delete, but the final design batches
    updates daily. Search behavior for a just-closed or deleted place and cache invalidation order are unspecified.
15. **Pagination and total order are absent.** Offset/keyset choice, distance ties, concurrent moves/deletes, snapshot identity, token
    integrity, expiry, and exact response-loss replay are all open.
16. **Availability and privacy are labels only.** Multi-region boxes have no ownership, replication, failover, RPO/RTO, or split
    brain rule; GDPR/CCPA have no retention, minimization, access, erasure, log, or precise-location boundary.
17. **Historic product/scale figures are uncited.** They are not current requirements and are not used as facts by this repository.

## Primary-source corrections

### Coordinate order and the antimeridian are explicit protocol choices

[RFC 7946](https://www.rfc-editor.org/rfc/rfc7946.html) defines geographic positions in longitude, latitude order using WGS 84
decimal degrees, states that decimal digits are not an uncertainty signal, and gives explicit antimeridian-spanning bounding-box
semantics. PostGIS [`ST_Point`](https://postgis.net/docs/ST_Point.html) likewise documents X as longitude and Y as latitude for
geodetic coordinates and shows SRID 4326 before casting to `geography`.

v0.1's JSON uses named `latitude`/`longitude` fields to avoid positional ambiguity, validates the closed domains `[-90,90]` and
`[-180,180]`, and constructs `ST_Point(longitude, latitude, 4326)::geography`. Generated tests include both sides of ±180°.

### The spatial index is a candidate accelerator, not the distance definition

PostGIS [`ST_DWithin`](https://postgis.net/docs/ST_DWithin.html) documents that `geography` distances are in meters, default to
spheroid measurement, and include an index-usable bounding-box comparison. [`ST_Distance`](https://postgis.net/docs/ST_Distance.html)
returns geodesic geography distance in meters on the SRID spheroid by default and uses GeographicLib in supported builds for
accuracy and robustness.

v0.1 stores `geography(Point,4326)` with a GiST index, uses `ST_DWithin(..., radius, true)` as the inclusive final predicate, and
orders by distance rounded to integer millimeters plus place ID. It does not expose a geohash prefix as distance or hand-code the
chapter's latitude-sensitive covering.

### A covering needs a stated completeness/performance contract

The official [S2 cell hierarchy guide](https://s2geometry.io/devguide/s2cell_hierarchy.html) says an `S2RegionCoverer` cell union is
guaranteed to cover the requested spherical cap, while also documenting that `max_cells` bounds search work/final size and trades
off approximation area. Its default eight cells are a tradeoff, not “the eight neighboring hashes” and not an exact inclusion
predicate.

This supports the closed-book distinction: a covering may safely overselect only if completeness is guaranteed and an exact final
predicate removes false positives. v0.1 delegates both index prefilter and final predicate to tested PostGIS geography functions;
S2 remains a future distributed-index option, not a placeholder dependency.

### A database snapshot ends with its transaction

PostgreSQL 17 [transaction-isolation documentation](https://www.postgresql.org/docs/17/transaction-iso.html) says Read Committed
can give successive statements different snapshots. Repeatable Read uses one stable transaction snapshot, prevents PostgreSQL
phantom reads, and requires callers to retry serialization failures.

A page token cannot keep a PostgreSQL transaction open across HTTP requests. v0.1 therefore creates one bounded search session in
a Repeatable Read transaction: it reads the catalog revision, computes at most 501 matches, rejects density above 500, and copies
the accepted ordered result metadata into session rows before commit. Later pages read only those rows. Raw query coordinates are
not persisted; a digest binds the stable search key and intent.

### Lost-update prevention remains a strong precondition

[RFC 9110, Section 13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1) uses strong `If-Match` comparison to prevent lost
updates and allows a false precondition to return `412 Precondition Failed`.

Every place update/delete rechecks the immutable current version under the catalog/place locks. A stable mutation key records the
exact applied or stale outcome so a response-loss retry does not reinterpret a newer catalog.

### Redis documentation remained candidate-only

The official Redis `GEOSEARCH` page appeared in public search, but the controlled fetch failed. It remains a candidate rather than
verified source evidence and is not used to justify implementation behavior. v0.1 deliberately has no Redis path.

## Decisions after comparison

- Use PostgreSQL 17 plus PostGIS `geography(Point,4326)` and a GiST current-place index. Place metadata and index membership change
  in the same row transaction; there is no derived Redis cache to reconcile.
- Keep immutable `place_versions` and one current `places` row. Create/update/delete, stable mutation receipt, catalog revision,
  current metadata/location, and version history commit together.
- Require exact strong `If-Match` for update/delete. Stale results are durable and consume no catalog revision.
- Make every search authenticated and idempotent. The stable key binds owner, named coordinates, radius, exact category, and page
  size; exact replay returns the same materialized session after response loss.
- Build a session under Repeatable Read, copy no more than 500 active matches in total order, persist only query digest plus result
  copies, and return an explicit density-limit error on the 501st match. Page tokens bind owner/session/next ordinal with HMAC.
- Use spheroid `ST_DWithin` and `ST_Distance`, round distance to integer millimeters for a stable key, and tie-break by place ID.
- Keep names/categories bounded portable ASCII and use only synthetic fixtures. Logs omit raw coordinates, names, IDs, keys,
  digests, tokens, and results.
- Call successful HTTP evidence `search_response` or `server_bytes_written`; never client receipt, map rendering, route correctness,
  physical visit, relevance, real-world catalog accuracy, or human satisfaction.

## Remaining unknowns

- Production spatial partitioning/cell covering, hot-cell splitting, distributed top-k, read-replica freshness, and cache/version
  invalidation.
- Fuzzy/category taxonomy, open-now/time zones, popularity/review/sponsored ranking, personalization, fairness, and explainability.
- Search-session retention/cleanup, key rotation, quota/rate limiting, anti-scraping, and precise-location privacy/compliance.
- Place-owner verification, moderation, duplicate/place merge, address/geocoding, map data licensing, and real-world accuracy.
- Multi-region catalog ownership, PostGIS failover, backup/restore, disaster recovery, and production capacity/SLA.
