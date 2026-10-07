ALTER TABLE users
  ADD COLUMN role text NOT NULL DEFAULT 'user',
  ADD CONSTRAINT users_role_valid CHECK (role IN ('user', 'admin'));

-- A durable singleton records initialization even if the administrator is later demoted.
CREATE TABLE admin_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_pk bigint NOT NULL REFERENCES users(id),
  initialized_at timestamptz NOT NULL DEFAULT now()
);
