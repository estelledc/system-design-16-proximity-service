# Verification record

## Layered evidence

| Layer | Gate | Proves | Does not prove |
|---|---|---|---|
| contract | `npm test` | deterministic validation, digest/token/service/HTTP behavior without a database | PostGIS geometry, locking, SQL plans, process crash recovery |
| database | `npm run test:postgres` | real PostgreSQL/PostGIS mutation, geography, snapshot, density, expiry, concurrency, GiST-plan behavior | remote deployment, replicas, production load |
| process | `npm run smoke:postgres` | actual server `SIGKILL` after committed search and same-session replay; frozen/current page split; log scan | remote client receipt, proxy behavior, multi-host failover |
| bounded cost | `npm run benchmark:postgres` | raw time/rate for one 50,000-row synthetic fixture on the named CI runtime | SLA, capacity, peak traffic, geographic realism |
| supply/repository | `npm run lint` and `npm audit --audit-level=high` | pinned policy/structure and known high-severity npm audit status at run time | absence of unknown vulnerabilities |

## Required database cases

The public matrix must execute, with zero skips:

- PostgreSQL 17/PostGIS 3.5 runtime assertion;
- exact mutation replay, changed-intent conflict, and owner scoping;
- two same-base updates: one commit plus one durable stale receipt and no extra revision;
- category/exact distance agreement with a direct PostGIS oracle and UUID tie break;
- opposite-longitude results at the antimeridian and near a pole;
- frozen second page after one place moves and another closes, versus a new current search;
- 501 exact matches producing no partial session;
- concurrent same-search-key convergence;
- owner/token/path/tamper/expiry rejection;
- query plan containing the partial active-place GiST index.

## Process-smoke oracle

The smoke uses only normal HTTP mutations/searches around one synthetic coordinate. It reads the database only after forced process
death to establish that the search session committed before response loss. Exact-key retry must recover that session and revision.

Final expected database state:

```json
{
  "revisions":5,
  "active_places":2,
  "closed_places":1,
  "versions":5,
  "mutations":5,
  "sessions":2,
  "results":4
}
```

The scan checks auth/page secrets, bearer/key values, synthetic names/coordinates, all returned place/version/session IDs, and the
page token against captured stdout/stderr. Zero matches is evidence about these process logs only.

## Benchmark fixture

- 50,000 deterministic current places plus 50,000 immutable versions;
- a 500 × 100 grid over latitude 25–49.95 and longitude -124–-67.57;
- alternating `coffee`/`library` categories;
- 200 sequential authenticated repository search sessions;
- 50 km radius, page size 100, maximum 500 materialized results;
- PostgreSQL/PostGIS and Node versions printed with seed time, sessions/s, p50/p95/max latency, and materialized row counts.

The fixture excludes network hops, HTTP parsing, replicas, caches, concurrent users, failures, realistic place density, traffic,
autoscaling, and multi-region behavior. There is no pass/fail throughput threshold and no extrapolation to production.

## Public receipts

Exact implementation commit, workflow run, per-runtime counts, benchmark observations, and final documentation commit are recorded
after the public CI run. Until that receipt is present and green, the database/process claims in this document are requirements,
not completed evidence.
