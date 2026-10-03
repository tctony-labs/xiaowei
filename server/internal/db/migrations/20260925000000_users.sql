CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_public_id_unique UNIQUE (user_id),
  CONSTRAINT users_public_id_format CHECK (user_id ~ '^u_[A-Za-z0-9_-]{22}$')
);
