# Versioned Proximity Search Lab

This clean-room system-design practice begins with one question: when places move, close, or change while users paginate nearby
results, how can a bounded spatial index avoid missing in-radius places and keep one search session stable?

The title-level prompt is commonly framed as “design a proximity service.” This repository does not copy a product, source
chapter, dataset, map, diagram, or proprietary behavior. The problem contract was frozen before consulting the fixed secondary
chapter.

## Implemented slice

- Closed-book problem contract: [docs/closed-book-contract.md](docs/closed-book-contract.md)
- Fixed-source comparison: [docs/research-log.md](docs/research-log.md)
- Architecture decision: [ADR 0001](docs/adr/0001-postgis-authority-and-materialized-search-sessions.md)
- Requirements and acceptance: [docs/requirements.md](docs/requirements.md)
- Architecture and failure windows: [docs/architecture.md](docs/architecture.md)
- HTTP contract: [docs/api.md](docs/api.md)
- Operations and destructive-test warning: [docs/operations.md](docs/operations.md)
- Threat/privacy boundaries: [docs/threat-model.md](docs/threat-model.md)
- Layered verification record: [docs/verification.md](docs/verification.md)

The runnable slice uses PostgreSQL 17/PostGIS 3.5 as the current catalog and exact spatial authority. Place metadata, lifecycle,
location, immutable version, idempotency receipt, and catalog revision commit together. An initial search uses spheroid
`ST_DWithin`, materializes at most 500 ordered results inside one Repeatable Read transaction, and returns owner-bound HMAC page
tokens. Later pages read only that frozen result set.

## Quick verification

Pure gates need Node.js 22 or newer:

```sh
npm ci --ignore-scripts
npm run check
```

Real spatial/transaction/process gates require an isolated disposable PostgreSQL/PostGIS lab database:

```sh
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/proximity
npm run test:postgres
npm run smoke:postgres
npm run benchmark:postgres
```

Those three commands reset the configured lab tables. Do not point them at shared or production data. Public CI executes the full
suite on Node.js 22, 24, and 26 against the pinned PostGIS image.

## Evidence boundary

The executable evidence can establish exact PostGIS inclusion/ranking for the tested coordinates, atomic current-row/index
mutation, durable response-loss replay, stable materialized pages, explicit dense-result failure, and server response bytes. It
must not call those facts client receipt, map rendering, route correctness, a business visit, recommendation quality, real-world
place accuracy, regulatory compliance, or production capacity.

## License

MIT. Third-party study material is not included.
