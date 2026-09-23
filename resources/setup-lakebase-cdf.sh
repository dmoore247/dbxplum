#!/usr/bin/env bash
# ============================================================================
# setup-lakebase-cdf.sh — provision Lakebase CDF for the medplum public schema
#
# Syncs the medplum Postgres `public` schema to Unity Catalog Delta history
# tables via Lakebase Change Data Feed (CDF).
#
# Steps (each is idempotent / re-runnable):
#   1. Ensure the Lakebase branch exists (cloned from production).
#   2. Ensure the destination UC schema exists (dmoore.dbxplum_history).
#   3. Run the DBA SQL to set REPLICA IDENTITY FULL on all public tables.
#   4. Enable CDF for schema `public` -> the destination UC schema.
#
# Usage:
#   resources/setup-lakebase-cdf.sh
#   PROFILE=FHIR BRANCH_ID=feature-cdf resources/setup-lakebase-cdf.sh
#
# Requirements: databricks CLI (>= 1.2.1), psql on PATH, jq.
#
# CLI-only by design (no Python SDK). The CDF enablement API is a Public
# Preview and has no CLI subcommand as of CLI v1.2.1 / SDK 0.117.0, so it is
# driven through `databricks api post`. If the preview's endpoint path or body
# differs in your workspace, update CDF_API_PATH / the JSON body below — the
# script fails loudly with the attempted request rather than guessing silently.
# ============================================================================
set -euo pipefail

# ---- Configuration (override via environment) ------------------------------
PROFILE="${PROFILE:-FHIR}"
PROJECT_ID="${PROJECT_ID:-medplum}"
BRANCH_ID="${BRANCH_ID:-feature-cdf}"
SOURCE_BRANCH_ID="${SOURCE_BRANCH_ID:-production}"
ENDPOINT_ID="${ENDPOINT_ID:-primary}"
PG_DATABASE="${PG_DATABASE:-databricks_postgres}"     # postgres connection db NAME (underscore)
PG_DATABASE_RESOURCE_ID="${PG_DATABASE_RESOURCE_ID:-databricks-postgres}"  # UC resource id (hyphen)
SOURCE_SCHEMA="${SOURCE_SCHEMA:-public}"
DEST_CATALOG="${DEST_CATALOG:-dmoore}"
DEST_SCHEMA="${DEST_SCHEMA:-dbxplum_history}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SQL_FILE:-$SCRIPT_DIR/lakebase-cdf-setup.sql}"

PROJECT="projects/${PROJECT_ID}"
BRANCH="${PROJECT}/branches/${BRANCH_ID}"
ENDPOINT="${BRANCH}/endpoints/${ENDPOINT_ID}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ! \033[0m%s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

dbx() { databricks -p "$PROFILE" "$@"; }

# ---- Preflight -------------------------------------------------------------
for bin in databricks psql jq; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH"
done

# ---- Step 1: Lakebase branch ----------------------------------------------
log "Step 1: Lakebase branch ${BRANCH}"
if dbx postgres get-branch "$BRANCH" >/dev/null 2>&1; then
  ok "branch already exists"
else
  dbx postgres create-branch "$PROJECT" "$BRANCH_ID" \
    --json "{\"spec\": {\"source_branch\": \"${PROJECT}/branches/${SOURCE_BRANCH_ID}\", \"no_expiry\": true}}" \
    >/dev/null
  ok "branch created from ${SOURCE_BRANCH_ID}"
fi

# ---- Step 2: Destination UC schema ----------------------------------------
log "Step 2: Unity Catalog schema ${DEST_CATALOG}.${DEST_SCHEMA}"
if dbx schemas get "${DEST_CATALOG}.${DEST_SCHEMA}" >/dev/null 2>&1; then
  ok "schema already exists"
else
  dbx schemas create "$DEST_SCHEMA" "$DEST_CATALOG" \
    --comment "Lakebase CDF destination: medplum ${SOURCE_SCHEMA} schema change history" \
    >/dev/null
  ok "schema created"
fi

# ---- Step 3: schema prep (REPLICA IDENTITY FULL + drop unused tables) ------
# The SQL sets REPLICA IDENTITY FULL on EVERY public base table (this CDF impl
# requires FULL on all tables, PK or not — tables at DEFAULT identity are SKIPPED
# and capture nothing) and drops the three empty unused lookup tables (Address,
# ContactPoint, Identifier). See resources/lakebase-cdf-setup.sql.
#
# The ALTERs need TABLE ownership: on medplum all public tables are owned by the
# app service principal, so run this step authenticated AS that SP via OAuth M2M
# (DATABRICKS_CLIENT_ID/SECRET + DATABRICKS_AUTH_TYPE=oauth-m2m). Under the -p
# FHIR user identity the ALTERs SKIP (not owner); the warning below flags that.
log "Step 3: schema prep on ${SOURCE_SCHEMA} (via ${SQL_FILE})"
SQL_LOG="$(mktemp)"
if ! dbx psql "$ENDPOINT" -- -d "$PG_DATABASE" -v ON_ERROR_STOP=1 -f "$SQL_FILE" >"$SQL_LOG" 2>&1; then
  cat "$SQL_LOG"; rm -f "$SQL_LOG"
  die "SQL step failed — see error above"
fi
grep -E 'NOTICE:.*(Dropped|already absent|REPLICA IDENTITY FULL set|already REPLICA)' "$SQL_LOG" | sed 's/^psql:[^ ]* //' || true
# REPLICA IDENTITY ALTERs need TABLE ownership (app service principal). ALTER
# skips (not a hard failure) surface here; drops work via schema ownership.
RI_SKIPPED=$(grep -c 'SKIPPED public.* must be table owner' "$SQL_LOG" || true)
rm -f "$SQL_LOG"
if [[ "${RI_SKIPPED:-0}" -gt 0 ]]; then
  warn "${RI_SKIPPED} table(s) could NOT get REPLICA IDENTITY FULL — not the table owner."
  warn "CDF will still run, but UPDATE/DELETE fidelity on those tables is reduced"
  warn "until set. Re-run Step 3 as the app service principal (PROFILE=<sp-profile>)"
  warn "or a superuser. Continuing to enable CDF."
else
  ok "schema prep complete (REPLICA IDENTITY set; unused tables dropped)"
fi

# ---- Step 4: Enable CDF (public -> dmoore.dbxplum_history) -----------------
log "Step 4: enable CDF ${SOURCE_SCHEMA} -> ${DEST_CATALOG}.${DEST_SCHEMA}"

# CDF config is a database-scoped resource (Public Preview). No CLI subcommand
# exists as of CLI v1.2.1 / SDK 0.117.0, so drive the REST API directly.
#   POST /api/2.0/postgres/{parent}/cdf-configs?cdf_config_id=<id>
#   body: {catalog, schema, postgres_schema}
# NOTE: the database resource id uses a hyphen (databricks-postgres), which is
# distinct from the Postgres database NAME (databricks_postgres, PG_DATABASE).
CDF_CONFIG_ID="${CDF_CONFIG_ID:-${SOURCE_SCHEMA}}"
CDF_PARENT="${BRANCH}/databases/${PG_DATABASE_RESOURCE_ID}"
CDF_LIST_PATH="/api/2.0/postgres/${CDF_PARENT}/cdf-configs"
CDF_POST_PATH="${CDF_LIST_PATH}?cdf_config_id=${CDF_CONFIG_ID}"
CDF_BODY=$(jq -n \
  --arg src "$SOURCE_SCHEMA" \
  --arg cat "$DEST_CATALOG" \
  --arg sch "$DEST_SCHEMA" \
  '{postgres_schema: $src, catalog: $cat, schema: $sch}')

# Idempotent: skip if a config with this id already exists.
if dbx api get "$CDF_LIST_PATH" 2>/dev/null | jq -e \
     --arg id "$CDF_CONFIG_ID" '.cdf_configs[]? | select(.cdf_config_id==$id or (.name|test($id+"$")))' \
     >/dev/null 2>&1; then
  ok "CDF config '${CDF_CONFIG_ID}' already exists"
else
  POST_ERR="$(mktemp)"
  if dbx api post "$CDF_POST_PATH" --json "$CDF_BODY" >"$POST_ERR" 2>&1; then
    rm -f "$POST_ERR"
    ok "CDF enabled: ${SOURCE_SCHEMA} -> ${DEST_CATALOG}.${DEST_SCHEMA} (config '${CDF_CONFIG_ID}')"
  else
    cat "$POST_ERR" >&2; rm -f "$POST_ERR"
    warn "POST ${CDF_POST_PATH}"
    warn "Body: ${CDF_BODY}"
    warn "If this failed on preview/permission: ensure the 'Lakebase Change Data"
    warn "Feed' preview is enabled (Settings -> Previews), that you have CAN MANAGE"
    warn "on the project + USE CATALOG/USE SCHEMA/CREATE TABLE on ${DEST_CATALOG}.${DEST_SCHEMA},"
    warn "and that REPLICA IDENTITY FULL is set on PK-less source tables (Step 3)."
    die  "CDF enablement step incomplete"
  fi
fi

log "Done. CDF flushes ~every 15s. Verify destination history tables:"
echo "  databricks -p $PROFILE tables list ${DEST_CATALOG} ${DEST_SCHEMA}   # expect lb_<table>_history"
