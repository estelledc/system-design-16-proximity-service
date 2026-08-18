# Closed-book contract: versioned proximity search

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. Product names identify
only the problem family. Scale figures, API shapes, index choices, ranking, and consistency are explicit hypotheses for this lab,
not facts about Yelp, Google Maps, or any current service. Later research must record confirmations, conflicts, omissions, and
changes instead of silently rewriting this baseline.

## Users and core behavior

### Searcher

1. A caller supplies one valid latitude/longitude, bounded radius, optional exact category, and page size.
2. The service returns active synthetic places whose exact distance is within the radius, in a deterministic total order.
3. Following a returned page token keeps the original query and catalog snapshot; a concurrent place move/close cannot cause a
   duplicate, skip, or query-shape change inside that session.
4. A new search may observe later committed catalog changes.
5. A server result proves only response generation, not client receipt, map display, route feasibility, a visit, or satisfaction.

### Place owner/operator

1. An authenticated operator creates, moves, recategorizes, closes, reopens, or tombstones one synthetic place with a stable
   mutation key and base version.
2. Exact response-loss replay returns the original result. Reusing the key for a changed intent conflicts.
3. A stale base cannot silently overwrite a newer location, category, or lifecycle.
4. Search metadata and spatial-index membership change atomically from the query service's point of view.

### Service operator

1. An operator can distinguish mutation commit, snapshot/index publication, search response, and downstream human outcome.
2. The index can be rebuilt and compared with a direct catalog oracle for a fixed revision.
3. Logs and metrics do not expose raw query coordinates, place identity, names, request keys, or page tokens.

## Non-goals for v0.1

- real people, devices, businesses, addresses, reviews, photos, phone numbers, or production map data;
- full-text/fuzzy search, semantic relevance, personalization, sponsored ranking, popularity, rating, or recommendation quality;
- opening-hours/time-zone logic, live availability, inventory, price, reservations, delivery, traffic, crowding, or presence;
- map tiles, geocoding/reverse geocoding, routes, travel time, turn-by-turn navigation, or road-network reachability;
- polygon regions, indoor maps, altitude, three-dimensional distance, or arbitrary global precision guarantees;
- owner verification, moderation, fraud/abuse prevention, anti-scraping, quota/billing, privacy/compliance, or data licensing;
- multi-region metadata, replicated index/object durability, failover, backup/restore, disaster recovery, or production deployment;
- proving a remote client received/rendered results, navigated, visited a place, or considered the ranking useful.

## Hypothetical scale envelope

The design conversation assumes, without claiming a real workload:

- 10 million daily searchers making 20 searches/day: 200 million/day, about 2,315/s average and 23,150/s at a 10× peak;
- 20 million active places, each with roughly 1 KiB of search metadata: about 20 GiB before indexes/replicas/history;
- 1% of places changed/day: 200,000 catalog mutations/day, about 2.3/s average and 23/s peak;
- radius 100 m–50 km and page size 1–100;
- a dense-cell worst case of 100,000 candidates before exact filtering is unacceptable for one request, so the implementation
  needs explicit candidate/page/work bounds rather than only a global QPS estimate;
- a 30-minute page-token lifetime is a future design input, not yet an implemented expiry guarantee.

These numbers choose failure modes. The runnable lab will use a small synthetic bounded region and report raw benchmark fixtures
without extrapolation.

## Candidate authority and state model

PostgreSQL is the proposed place-catalog and publication authority. A deterministic spatial covering/index is a derived read model,
not a second source of truth.

Candidate records:

- `catalog_state`: last committed catalog revision and currently published index snapshot;
- `places`: stable ID, version, coordinates, category, lifecycle, and update revision;
- `mutation_requests`: operator + stable key, immutable intent digest, and exact durable result;
- `catalog_changes`: committed revision, place ID, old/new index membership, and lifecycle change;
- `index_snapshots`: immutable build ID, frozen upper revision, algorithm/policy fingerprint, state, and content digest;
- `index_cells`: snapshot, spatial cell, place/version reference, and coordinates required for exact filtering.

Candidate place lifecycle:

```text
absent -> active <-> closed -> tombstoned
             |
             +-- move/category update -> active with new immutable version
```

Candidate snapshot lifecycle:

```text
building -> ready -> published
         +-------> rejected
```

Whether v0.1 updates a mutable transactional index directly or publishes immutable snapshots remains undecided until source and
primary-spec review. Search metadata and the index entry used for a result may never silently refer to different place versions.

## Core invariants

1. **Coordinate domain.** Latitude, longitude, radius, category, limit, token, and mutation inputs use one documented canonical
   domain. NaN/infinity, negative/oversized radius, ambiguous longitude wrapping, and unknown fields fail before index work.
2. **Covering completeness.** For every supported query circle and committed active place inside its boundary, candidate generation
   includes that place before exact filtering. Extra candidates are allowed; false negatives from cell edges are not.
3. **Exact final predicate.** Cell/prefix membership is never the final distance answer. One specified Earth model and boundary
   rule decide `distance <= radius`; antimeridian and supported polar behavior are explicit and tested.
4. **Deterministic total order.** Results sort by the chosen exact/quantized distance key and stable place ID. Equal distance cannot
   make page order depend on database or hash iteration order.
5. **Atomic catalog/index visibility.** A search sees either the old place version and old index membership or the new version and
   new membership. It cannot return new metadata from an old location or miss both sides of a committed move.
6. **Stable mutation intent.** Reusing a mutation key with changed operator, place, base version, coordinates, category, lifecycle,
   or operation conflicts; exact replay returns the original durable result.
7. **No silent stale overwrite.** Move/category/lifecycle mutation is conditional on the base place version observed by the caller.
   A stale mutation changes no catalog/index state while returning success.
8. **Stable page session.** A page token binds canonical query shape, ranking/index policy, catalog/snapshot version, last total-order
   key, and expiry/version semantics. Following it cannot absorb later catalog writes or change radius/category.
9. **Lifecycle authorization.** Closed/tombstoned places are excluded according to the frozen session contract. Physical index rows
   alone do not authorize a result.
10. **Bounded amplification.** Cell covering count, per-cell candidates, total candidates, exact-distance work, page size, token
    length, request body, and mutation retries have explicit bounds and fail/degrade visibly.
11. **Derived-index auditability.** For a frozen revision, index results can be checked against a direct catalog scan/brute-force
    oracle, with deterministic digest/count evidence. A successful build command alone is not publication proof.
12. **Location privacy in evidence.** Raw query coordinates, place coordinates/names/IDs, mutation keys, tokens, and result bodies do
    not enter logs/metric labels. Aggregate count/latency or coarse synthetic test labels remain distinct from real privacy safety.
13. **Evidence separation.** `catalog_mutation_committed`, `index_snapshot_published`, `search_response`, and
    `server_bytes_written` are distinct. None implies client receipt, map rendering, route correctness, a physical visit, ranking
    quality, catalog real-world accuracy, or production acceptance.

## Initial API sketch

Authenticated operator routes:

- `POST /v1/places` with a stable key and `{name, category, latitude, longitude}`;
- `PUT /v1/places/{placeId}` with a stable key, strong base-version validator, and exact changed fields;
- `POST /v1/places/{placeId}/close` and `/reopen`, or one smaller lifecycle mutation contract;
- `DELETE /v1/places/{placeId}` with a strong base version.

Public or separately authenticated search route:

- `GET /v1/nearby?lat=<...>&lon=<...>&radiusMeters=<...>&category=<...>&limit=<...>&pageToken=<...>`.

Exact fields, numeric representation, coordinate model, index choice, status codes, and publication model remain hypotheses until
primary specifications are reviewed. Tokens are opaque externally even if the lab encodes bounded snapshot/order state.

## Failure matrix

| Failure window | Required result |
|---|---|
| two creates race under one mutation key | one place/version wins; exact replay converges; changed intent conflicts |
| move metadata commits but index update/build does not | published search stays on the prior coherent view or mutation rolls back; never a mixed version |
| index objects/rows are written, then builder dies before publish | work remains invisible and may be verified/reused or discarded |
| mutation commits, then response is lost | exact replay returns the same place/version/revision without a second mutation |
| two operators update one base version | at most one becomes current; loser receives a durable stale outcome |
| query circle crosses a cell edge | every in-radius oracle place is still a candidate and result |
| query crosses ±180° longitude | canonical wrapping and covering do not omit the opposite-side neighbor |
| place moves while caller follows pages | existing page chain stays on one frozen view; a new search may see the move |
| place closes after page 1 | frozen-session visibility follows the documented snapshot choice; no unannounced hybrid semantics |
| dense cell exceeds candidate budget | return an explicit bounded error or documented partial/degraded result, never silently claim completeness |
| index entry references missing/wrong place version | search fails closed or excludes with integrity evidence; it does not substitute metadata |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API, operations, threat model, and ADR.
2. Exact coordinate/radius/token validation and deterministic distance/order unit tests.
3. Generated property tests comparing index search with a brute-force oracle across random points, radii, cell boundaries,
   antimeridian cases, empty/dense cells, and tie distances in the explicitly supported region.
4. Real PostgreSQL tests for mutation idempotency, stale updates, atomic metadata/index visibility or immutable publication,
   concurrent move/search boundaries, lifecycle, and stable page sessions.
5. A true-process crash smoke covering response loss and any build-before-publish recovery path selected by the ADR.
6. A bounded benchmark with exact point distribution, radius, density, candidate counts, runtime/PostgreSQL versions, exclusions,
   and raw latency/rate observations.
7. Node 22/24/26 public CI with PostgreSQL 17.6, pinned actions, dependency audit, no skipped tests, and exact commit/run receipts.
8. Log scans and evidence vocabulary checks that prevent raw synthetic coordinates/identities from becoming claimed user outcomes.

## Initial design choices to challenge after source review

- Does the chapter require globally correct radius search, or only nearby candidates under one spatial partition approximation?
- Which structure is proposed—geohash, quadtree, S2/H3-like cells, database spatial index—and what completeness proof is missing?
- How are cell precision and radius mapped without false negatives at boundaries or unbounded neighbor enumeration?
- Is distance only ranking/filtering, or is a cell prefix incorrectly treated as the answer?
- How do place moves, closes, and deletes update the business row, cache, replica/index, and stable pagination atomically?
- Does pagination bind a snapshot and total order, or use a live offset that can duplicate/skip under concurrent changes?
- Are popularity/rating/open-now mixed into “nearby” without versioned ranking inputs and explainable consistency?
- Which scale, product, QPS, and latency figures are historic, cited, internally reproducible, or silently assumed?

Implementation remains pending until this baseline is committed, the fixed source is inspected, primary specifications are
verified, and the smallest executable invariant is selected.
