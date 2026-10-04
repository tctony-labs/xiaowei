CREATE TABLE email_identities (
  user_pk bigint PRIMARY KEY REFERENCES users(id),
  email text COLLATE "C" NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CHECK (email = lower(email) AND email = btrim(email) AND octet_length(email) BETWEEN 3 AND 254)
);

CREATE TABLE user_devices (
  user_pk bigint NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL,
  device_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  PRIMARY KEY (user_pk, device_id),
  CHECK (device_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (octet_length(device_name) <= 128)
);

CREATE TABLE auth_sessions (
  session_id text COLLATE "C" PRIMARY KEY,
  user_pk bigint NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL,
  refresh_token_hash bytea NOT NULL UNIQUE,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,

  FOREIGN KEY (user_pk, device_id) REFERENCES user_devices(user_pk, device_id),
  CHECK (session_id ~ '^s_[A-Za-z0-9_-]{22}$'),
  CHECK (octet_length(refresh_token_hash) = 32)
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_pk);

CREATE UNIQUE INDEX auth_sessions_active_device_idx
  ON auth_sessions (user_pk, device_id) WHERE revoked_at IS NULL;

CREATE TABLE session_access_tokens (
  token_hash bytea PRIMARY KEY,
  session_id text COLLATE "C" NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,

  CHECK (octet_length(token_hash) = 32)
);

CREATE INDEX session_access_tokens_session_idx ON session_access_tokens (session_id);
