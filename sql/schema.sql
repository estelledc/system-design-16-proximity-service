CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  committed_revision bigint NOT NULL DEFAULT 0 CHECK (committed_revision >= 0)
);

INSERT INTO catalog_state (singleton, committed_revision)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS places (
  place_id uuid PRIMARY KEY,
  owner_fingerprint text NOT NULL CHECK (length(owner_fingerprint) = 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude >= -180 AND longitude < 180),
  location geography(Point, 4326) NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'closed', 'tombstoned')),
  version_id uuid NOT NULL UNIQUE,
  version_number integer NOT NULL CHECK (version_number > 0),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS places_active_location_gist
  ON places USING gist (location)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS places_active_category
  ON places (category)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS place_versions (
  version_id uuid PRIMARY KEY,
  place_id uuid NOT NULL REFERENCES places(place_id),
  predecessor_version_id uuid,
  version_number integer NOT NULL CHECK (version_number > 0),
  owner_fingerprint text NOT NULL CHECK (length(owner_fingerprint) = 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude >= -180 AND longitude < 180),
  state text NOT NULL CHECK (state IN ('active', 'closed', 'tombstoned')),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  committed_at timestamptz NOT NULL,
  UNIQUE (place_id, version_number)
);

CREATE TABLE IF NOT EXISTS mutation_requests (
  owner_fingerprint text NOT NULL CHECK (length(owner_fingerprint) = 64),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  intent_digest text NOT NULL CHECK (length(intent_digest) = 64),
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'precondition_failed')),
  place_id uuid NOT NULL,
  result_version_id uuid NOT NULL,
  result_version_number integer NOT NULL CHECK (result_version_number > 0),
  result_revision bigint,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_fingerprint, request_key),
  CHECK (
    (outcome = 'applied' AND result_revision IS NOT NULL AND result_revision > 0)
    OR (outcome = 'precondition_failed' AND result_revision IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS search_sessions (
  session_id uuid PRIMARY KEY,
  owner_fingerprint text NOT NULL CHECK (length(owner_fingerprint) = 64),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  intent_digest text NOT NULL CHECK (length(intent_digest) = 64),
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision >= 0),
  page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND 100),
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 500),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  CONSTRAINT search_sessions_owner_key_unique UNIQUE (owner_fingerprint, request_key)
);

CREATE TABLE IF NOT EXISTS search_session_results (
  session_id uuid NOT NULL REFERENCES search_sessions(session_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  place_id uuid NOT NULL,
  version_id uuid NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  distance_mm bigint NOT NULL CHECK (distance_mm >= 0),
  PRIMARY KEY (session_id, ordinal),
  UNIQUE (session_id, place_id)
);
