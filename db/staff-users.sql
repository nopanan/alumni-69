-- Usernames for staff accounts. Password hashes remain managed by Supabase Auth.
BEGIN;
CREATE TABLE IF NOT EXISTS alumni_69.staff_users (
  auth_user_id uuid PRIMARY KEY REFERENCES alumni_69.staff_accounts(auth_user_id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT staff_users_username_check CHECK (username ~ '^[a-z][a-z0-9._-]{2,49}$')
);
ALTER TABLE alumni_69.staff_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE alumni_69.staff_users FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE alumni_69.staff_users TO service_role;
-- Resolve a staff username to its Auth email; password hash columns are not granted.
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT(id,email) ON auth.users TO service_role;
COMMIT;
