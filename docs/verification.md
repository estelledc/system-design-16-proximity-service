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

The public repository is
[`estelledc/system-design-16-proximity-service`](https://github.com/estelledc/system-design-16-proximity-service), MIT licensed on
`main`.

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the five commits in order: `b0a10382a5da773b5651d6459236b6c6e59ea8d1` → `5bdf56dafbe509cc9de306c2bd4719e35fe8cbf9`, `79ca1bdf857ff1d194222c8364f721f069705862` → `914485ca84221eca25d8e57a56455dc6bfca395a`, `1b2ebab7ca6bac7a747317e9b585fe503f8347df` → `d3286ed386f23720e062e277b0454c6b4ce225df`, `01e6aa2cda524e56cc2b3b2bb8eb121bd5dac18c` → `e9831cf3e88d85ff7220be833175493a888cfcc8`, and `44a3d6cf128d9db39568e5462ef5d556e804edcd` → `aea7fe9a363b77bf2718fecc64824996cc1ad9f6`. The older runs below remain bound to their pre-rewrite commit objects.

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline `aea7fe9a363b77bf2718fecc64824996cc1ad9f6` passed [CI run 32226453535](https://github.com/estelledc/system-design-16-proximity-service/actions/runs/32226453535) on Node 22, 24, and 26 with PostgreSQL 17 / PostGIS 3.5 and the full quality gate.

### Implementation and privacy-hardening runs

1. Tree-equivalent commit [`d3286ed386f23720e062e277b0454c6b4ce225df`](https://github.com/estelledc/system-design-16-proximity-service/commit/d3286ed386f23720e062e277b0454c6b4ce225df)
   first ran the full executable slice in public CI
   [run 32182251994](https://github.com/estelledc/system-design-16-proximity-service/actions/runs/32182251994). All three jobs
   passed. Log review then found that the intentionally raced unique constraint made PostgreSQL's own service log print the
   synthetic owner fingerprint and request key. The application process scan was clean, but that database-log path was still a
   privacy defect worth removing.
2. Tree-equivalent commit [`e9831cf3e88d85ff7220be833175493a888cfcc8`](https://github.com/estelledc/system-design-16-proximity-service/commit/e9831cf3e88d85ff7220be833175493a888cfcc8)
   added pre-snapshot same-key advisory locking. Public CI
   [run 32182481047](https://github.com/estelledc/system-design-16-proximity-service/actions/runs/32182481047) passed all three
   jobs, and a full-log search found neither the prior duplicate-key message nor the synthetic concurrent-search key.

The hardening run used PostgreSQL `17.11` and PostGIS `3.5.7`. Each Node job reported:

- repository policy check: 37 files and local Markdown links checked;
- pure tests: 13 passed, 0 failed, 0 skipped;
- real PostGIS tests: 10 passed, 0 failed, 0 skipped;
- npm audit: 0 known vulnerabilities at the configured high-severity threshold;
- process smoke: `SIGKILL`, same-session response-loss recovery, frozen old page, revision-5 current search, exact expected table
  counts, 0 application-log leak matches, and 0 client/map/visit/human-outcome claims.

### Bounded benchmark observations

All observations come from run `32182481047` and the exact 50,000-row/200-session fixture above. They are not thresholds or
capacity claims.

| Runtime | Seed ms | Sessions/s | p50 ms | p95 ms | Max ms | Materialized rows | Max/session |
|---|---:|---:|---:|---:|---:|---:|---:|
| Node 22.23.2 | 2,714.479 | 180.469 | 5.318 | 6.344 | 24.828 | 2,420 | 19 |
| Node 24.19.0 | 2,674.955 | 196.593 | 4.884 | 5.795 | 24.258 | 2,420 | 19 |
| Node 26.7.0 | 2,676.278 | 189.660 | 5.091 | 6.030 | 24.471 | 2,420 | 19 |

The historical closed-book contract named PostgreSQL 17.6 before execution. The pinned moving image tag resolved to 17.11 during
these runs; this verification record reports the observed patch version rather than silently preserving the estimate. Reproducible
image-digest pinning remains an operations gap even though the major/PostGIS family gate passed.
