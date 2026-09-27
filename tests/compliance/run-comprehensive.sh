#!/usr/bin/env bash
# ============================================================================
# run-comprehensive.sh — end-to-end US Core v7 compliance run against a Medplum
# deployment backed by ANY Lakebase branch.
#
# Reproducible pipeline:
#   1. fetch pinned US Core reference data (inferno-reference-server-data)
#   2. load all US Core patient bundles into Medplum  (data/load-us-core-data.mjs)
#   3. generate gap-filling resources                 (data/generate-gap-data.mjs)
#   4. run the Inferno US Core v7 FHIR API suite       (run-us-core-suite.mjs)
#
# The Inferno stack (docker) and the auth-injecting proxy must already be up:
#   see README.md "One-time setup".  This script drives DATA + RUN, which is
#   what changes per Lakebase branch.
#
# Required env (no secrets are written to disk):
#   MEDPLUM_URL            e.g. https://<app-host>.databricksapps.com
#   MEDPLUM_CLIENT_ID      Medplum ClientApplication id (FullAccessPolicy)
#   MEDPLUM_CLIENT_SECRET  its secret
#   DATABRICKS_PROFILE     CLI profile for the gateway token (default FHIR)
# Optional:
#   FHIR_URL               what Inferno tests (default proxy via host.docker.internal)
#   SKIP_LOAD=1            skip data load/generate (data already present)
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_REPO="https://github.com/inferno-framework/inferno-reference-server-data"
WORK="${WORK:-/tmp/uscore-refdata}"
PROFILE="${DATABRICKS_PROFILE:-FHIR}"

: "${MEDPLUM_URL:?set MEDPLUM_URL}"
: "${MEDPLUM_CLIENT_ID:?set MEDPLUM_CLIENT_ID}"
: "${MEDPLUM_CLIENT_SECRET:?set MEDPLUM_CLIENT_SECRET}"
export DATABRICKS_TOKEN="${DATABRICKS_TOKEN:-$(databricks auth token -p "$PROFILE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')}"
export MEDPLUM_URL MEDPLUM_CLIENT_ID MEDPLUM_CLIENT_SECRET

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ "${SKIP_LOAD:-0}" != "1" ]]; then
  # 1. fetch pinned reference data
  if [[ ! -d "$WORK" ]]; then
    log "Fetching US Core reference data → $WORK"
    git clone --depth 1 "$DATA_REPO" "$WORK"
  fi

  # 2. load US Core patient bundles (the 5 uscore_* patients — the US-Core-native
  #    set; other-IG bundles are intentionally excluded to avoid non-conformant
  #    resources polluting the profile-validation results).
  log "Loading US Core patient bundles"
  MANIFEST="$WORK/manifest.json" node "$HERE/data/load-us-core-data.mjs" \
    "$WORK/resources/uscore_bundle_patient_85.json" \
    "$WORK/resources/uscore_bundle_patient_355.json" \
    "$WORK/resources/uscore_bundle_patient_907.json" \
    "$WORK/resources/uscore_bundle_patient_908.json" \
    "$WORK/resources/uscore_bundle_patient_client_test.json"

  # 3. generate gap-filling resources against the richest patient (85 → first id)
  log "Generating gap-filling resources"
  PATIENT_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["patient_ids"][0])' "$WORK/manifest.json")" \
    node "$HERE/data/generate-gap-data.mjs"
fi

# 4. run the suite
log "Running Inferno US Core v7 FHIR API suite"
OUT="$HERE/results/us_core_v700_run_$(date +%Y%m%d_%H%M%S).json" \
  MANIFEST="${WORK}/manifest.json" \
  ${FHIR_URL:+FHIR_URL="$FHIR_URL"} \
  node "$HERE/run-us-core-suite.mjs"
