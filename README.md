# Versioned Proximity Search Lab

This clean-room system-design practice begins with one question: when places move, close, or change while users paginate nearby
results, how can a bounded spatial index avoid missing in-radius places and keep one search session stable?

The title-level prompt is commonly framed as “design a proximity service.” This repository does not copy a product, source
chapter, dataset, map, diagram, or proprietary behavior. The problem contract was frozen before consulting the fixed secondary
chapter.

## Current phase

- Closed-book problem contract: [docs/closed-book-contract.md](docs/closed-book-contract.md)
- Fixed-source comparison: [docs/research-log.md](docs/research-log.md)
- Architecture decision: [ADR 0001](docs/adr/0001-postgis-authority-and-materialized-search-sessions.md)
- Runnable slice and public CI: pending

## Evidence boundary

The intended vertical slice may prove supported-region covering completeness against a brute-force oracle, exact distance/ranking
semantics, atomic catalog/index publication, stable pagination, and server response bytes. It must not call those facts client
receipt, map rendering, route correctness, a business visit, recommendation quality, real-world place accuracy, or production
capacity.

## License

MIT. Third-party study material is not included.
