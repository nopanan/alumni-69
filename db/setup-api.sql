-- Additive API support only. Existing alumni_69 tables/functions are untouched.
-- Apply explicitly with npm run db:setup after reviewing the target DATABASE_URL.
BEGIN;
CREATE SCHEMA IF NOT EXISTS alumni_api_private;
REVOKE ALL ON SCHEMA alumni_api_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS alumni_api_private.customer_sessions (
  token_hash text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES alumni_69.customers(id),
  line_access_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_sessions_expiry_idx ON alumni_api_private.customer_sessions(expires_at);

CREATE TABLE IF NOT EXISTS alumni_api_private.oauth_states (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS alumni_api_private.line_acknowledgements (
  customer_id uuid PRIMARY KEY REFERENCES alumni_69.customers(id),
  group_acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS alumni_api_private.booking_requests (
  customer_id uuid NOT NULL REFERENCES alumni_69.customers(id),
  request_key text NOT NULL,
  body_hash text NOT NULL,
  booking_id uuid NOT NULL REFERENCES alumni_69.bookings(id),
  PRIMARY KEY(customer_id, request_key)
);
ALTER TABLE alumni_api_private.customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_api_private.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_api_private.line_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_api_private.booking_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA alumni_api_private FROM PUBLIC;

-- This private schema must NOT be included in PostgREST exposed schemas.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT USAGE ON SCHEMA alumni_api_private TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA alumni_api_private TO service_role;
  END IF;
END $$;
COMMIT;
