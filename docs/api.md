# HTTP API

## Common contract

- `/healthz` is public. Every `/v1` route requires `Authorization: Bearer <token>`.
- Mutation and initial-search POST/PUT/DELETE routes require `Idempotency-Key`.
- JSON request bodies require `Content-Type: application/json` and reject unknown fields.
- Successful and error JSON use `Cache-Control: private, no-store`.
- Place versions use one strong ETag: `"pv:<version-uuid>"`.
- Example values are synthetic. A successful response proves only that the server produced bytes.

Errors have one stable shape:

```json
{"error":{"code":"invalid_request","message":"request fields do not match the documented contract"}}
```

## Create a place

`POST /v1/places`

```json
{"name":"Sample Cafe","category":"coffee","latitude":37.7749,"longitude":-122.4194}
```

The first commit returns `201`, a strong `ETag`, and:

```json
{
  "operation":"create",
  "placeId":"<uuid>",
  "versionId":"<uuid>",
  "versionNumber":1,
  "catalogRevision":1,
  "replayed":false
}
```

Exact replay returns `200` and the same identifiers/revision with `replayed: true`. Reusing the key with different content returns
`409 intent_conflict`.

## Read, replace, or tombstone a place

- `GET /v1/places/{placeId}` returns the current owner-scoped non-tombstoned record and ETag.
- `PUT /v1/places/{placeId}` requires `If-Match` and a full replacement body.
- `DELETE /v1/places/{placeId}` requires `If-Match`; it creates an immutable tombstone version rather than physically deleting
  history.

Replacement body:

```json
{
  "name":"Sample Cafe",
  "category":"coffee",
  "latitude":37.775,
  "longitude":-122.419,
  "state":"active"
}
```

`state` may be `active` or `closed`. A stale base returns `412 precondition_failed` plus the current strong ETag. The stale outcome
is durable under its request key and consumes no catalog revision. A tombstoned current read/update/delete returns `410`.

## Open a search session

`POST /v1/search-sessions`

```json
{
  "latitude":37.7749,
  "longitude":-122.4194,
  "radiusMeters":2000,
  "pageSize":2,
  "category":"coffee"
}
```

`category` is optional. First commit returns `201`; exact replay returns `200`. The response includes the complete-session count,
frozen catalog revision, first ordered page, and a continuation only when another page exists:

```json
{
  "sessionId":"<uuid>",
  "snapshotRevision":3,
  "resultCount":3,
  "expiresAt":"2026-08-19T08:30:00.000Z",
  "items":[
    {
      "placeId":"<uuid>",
      "versionId":"<uuid>",
      "name":"Sample Cafe",
      "category":"coffee",
      "latitude":37.7749,
      "longitude":-122.4194,
      "distanceMillimeters":0
    }
  ],
  "nextPageToken":"<opaque>",
  "replayed":false
}
```

More than 500 exact matches returns `422 density_limit_exceeded` and commits no partial session.

## Read the next frozen page

`GET /v1/search-sessions/{sessionId}?pageToken=<opaque>`

The token must belong to the authenticated owner and path session. The response repeats the session metadata and returns the next
fixed ordinal slice. It omits `nextPageToken` on the final page. Expiry returns `410`; invalid/tampered/misaligned tokens return a
bounded error and never restart the query.

## Status summary

| Status | Meaning |
|---|---|
| `200` | read, update/delete, exact replay, or later page succeeded |
| `201` | a create or search session was newly committed |
| `400` | bounded validation/token/body failure |
| `401` | bearer authentication missing or malformed |
| `404` | route or owner-scoped resource absent |
| `409` | stable key reused for changed intent |
| `410` | place tombstoned or search session expired |
| `412` | strong place-version precondition is stale |
| `422` | 501st exact search result hit the materialization ceiling |
| `500` | sanitized unexpected server failure |
