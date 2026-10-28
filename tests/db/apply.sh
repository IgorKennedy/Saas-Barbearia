#!/usr/bin/env bash
# Recreates a throwaway database and applies stub + all migrations.
set -euo pipefail
DB=${TEST_DB:-barber_test}
export PGPASSWORD=${PGPASSWORD:-postgres}
P="psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
$P -d $DB -f "$(dirname "$0")/stub-supabase.sql"
for f in "$(dirname "$0")"/../../supabase/migrations/*.sql; do $P -d $DB -f "$f"; done
echo "migrations applied to $DB"
