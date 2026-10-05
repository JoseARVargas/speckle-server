-- Least-privilege Postgres role for the coord-worker (A01/A05).
-- Run as the database owner, passing the password as a psql variable so it
-- never lands in a file or in shell history:
--   psql -v worker_password="$COORD_WORKER_DB_PASSWORD" -d speckle -f coord_worker_role.sql
-- Idempotent: safe to re-run after new coord_* migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'coord_worker') THEN
    CREATE ROLE coord_worker LOGIN;
  END IF;
END
$$;
ALTER ROLE coord_worker WITH LOGIN PASSWORD :'worker_password';

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coord_worker;
GRANT USAGE ON SCHEMA public TO coord_worker;

-- Claim IDS runs and move them through ids_running / ids_done / failed.
-- (SELECT ... FOR UPDATE needs UPDATE on at least one column.)
GRANT SELECT ON coord_check_runs TO coord_worker;
GRANT UPDATE (status, attempt, "startedAt", "finishedAt", error)
  ON coord_check_runs TO coord_worker;

-- Read the IDS XML and the rule ids of the run's rule set version.
GRANT SELECT ON coord_rule_set_versions TO coord_worker;
GRANT SELECT (id, "ruleSetVersionId", definition) ON coord_rules TO coord_worker;

-- Write per-element results (DELETE clears a previous attempt of the run).
GRANT INSERT, DELETE ON coord_check_results TO coord_worker;
GRANT SELECT ("runId") ON coord_check_results TO coord_worker;

-- Clash runs: claim geometry runs and move them through geometry_running /
-- geometry_done / failed, recording geometrySeconds and peakRssMb.
GRANT SELECT ON coord_clash_runs TO coord_worker;
GRANT UPDATE (status, attempt, "startedAt", "finishedAt", error, "geometrySeconds", "peakRssMb")
  ON coord_clash_runs TO coord_worker;

-- Read the GlobalIds selected for each side of the run.
GRANT SELECT ("runId", side, "elementKey") ON coord_clash_run_elements TO coord_worker;

-- Write raw pairs (DELETE clears a previous attempt of the run).
GRANT INSERT, DELETE ON coord_clash_raw TO coord_worker;
GRANT SELECT ("runId") ON coord_clash_raw TO coord_worker;
