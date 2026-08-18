# Threat model

## Assets and trust boundaries

Protected assets are bearer credentials, precise query/place locations, names/categories, stable place/session/version identities,
idempotency keys, request digests, page tokens, mutation/version history, and database credentials.

The runnable boundary is one HTTP process plus one PostgreSQL/PostGIS instance. Bearer authentication is syntactic laboratory input,
not a complete identity provider. TLS termination, credential issuance/revocation, database network isolation, host security, and
operator access are assumed external and therefore unproved.

## Implemented controls

| Threat | Control in v0.1 | Residual risk |
|---|---|---|
| malformed/ambiguous coordinates | finite named numbers, closed range, `+180 -> -180`, point order tested | no accuracy/uncertainty model |
| oversized parser/search work | 16 KiB body, field allowlist, bounded radius/page/token, statement timeout, 501 gate | internal spatial work is not strictly counted |
| lost update | exact strong ETag checked under catalog/place locks | global lock limits throughput |
| idempotency-key substitution | owner-scoped key plus canonical SHA-256 intent digest; changed intent conflicts | digest is not encryption and has retention risk |
| page-token forgery or swapping | HMAC-SHA-256, canonical payload, timing-safe signature, owner/session/ordinal/expiry checks | one unversioned active key; no revocation |
| cross-owner object access | every place/session lookup includes owner fingerprint | bearer issuance and authorization policy absent |
| stale cache/index leak | no second cache/index authority; location/details/lifecycle share one current row | no distributed read model/failover proof |
| partial dense result mislabeled complete | 501st exact match aborts before session commit | caller cannot refine except by changing intent |
| location/identity in ordinary logs | aggregate allowlist plus process-smoke forbidden-value scan | database/audit/platform logs need separate controls |
| response-loss duplicate write/search | durable mutation receipt or materialized session before response | receipt/session retention cleanup absent |
| SQL injection | fixed SQL and bound parameters; category/name never become SQL syntax | dependency/database vulnerabilities remain possible |

## Privacy boundaries

- Owner fingerprints are keyed pseudonyms, not anonymity. Compromise of the auth HMAC key enables stable-token dictionary checks.
- Search sessions omit raw query coordinates but store a plain intent digest and copied result locations/identities. A small query
  domain may be guessed, and result copies remain sensitive.
- Place version history is append-only in v0.1. That conflicts with an unimplemented real-world erasure/retention policy.
- Exact locations are returned to an authenticated caller without purpose limitation, consent, field-level authorization, rate
  limits, or anti-enumeration controls.
- Synthetic fixtures and leak scans reduce test-data risk; they do not establish GDPR, CCPA, or any production compliance.

## Abuse cases intentionally not solved

- credential theft, automated scraping, coordinate probing, catalog poisoning, fake place ownership, spam, and denial of service;
- duplicate/merged places, moderation, legal takedown, audit access, retention, deletion, and data-subject workflows;
- traffic analysis through counts/latencies, database superuser access, host compromise, backups, crash dumps, and telemetry agents;
- multi-region replay, split brain, replica lag, disaster recovery, supply-chain compromise, and malicious dependency maintainers.

## Evidence-language rule

Allowed server evidence includes `catalog_mutation_committed`, `precondition_failed`, `search_session_committed`,
`search_response`, and `server_bytes_written`. None may be translated into client receipt, map rendering, road reachability,
physical visit, recommendation quality, catalog truth, human satisfaction, production acceptance, or regulatory compliance.
