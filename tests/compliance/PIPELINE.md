# Reproducible US Core v7 compliance pipeline

Run the full Inferno US Core v7 FHIR API compliance suite against a Medplum
deployment backed by **any Lakebase branch**, with data loading + gap-filling
that reproduce the same result every time.

## Components

| File | Role |
|------|------|
| `proxy/server.js` | Auth-injecting reverse proxy: adds the Databricks gateway token (header) + Medplum token (`__medplum_token` cookie), decompresses/rewrites Bundle pagination links back through itself. |
| `data/load-us-core-data.mjs` | Loads US Core reference bundles into Medplum (ref-style normalization, rate-limit chunking, writes a patient-id manifest). |
| `data/generate-gap-data.mjs` | Generates conformant resources for must-support / clinical-note gaps the standard bundles leave. |
| `run-us-core-suite.mjs` | Headlessly drives the Inferno API: session → run the FHIR API group → poll → report tally + skips. |
| `run-comprehensive.sh` | Orchestrates fetch-data → load → generate → run for one target. |

## One-time setup (Inferno stack + proxy)

Inferno itself runs from the official `inferno-template` (with `us_core_test_kit`
added and `json` pinned to `~> 2.7`). Requirements:

- **Docker Desktop with ≥ 16 GB memory** — the HL7 validator alone uses ~7 GB;
  at 8 GB it is OOM-killed (exit 137) and every profile-validation test errors
  with "Connection failed to validator". (Docker Desktop rewrites its settings
  on quit, so edit `MemoryMiB` in `settings-store.json` **while Docker is fully
  stopped**, then start it.)
- Build with the **classic builder** (`DOCKER_BUILDKIT=0`) — buildx can hang.

```sh
# in the inferno-template checkout (us_core_test_kit in gemspec, json ~>2.7 in Gemfile)
DOCKER_BUILDKIT=0 docker compose build
docker compose run --rm inferno bundle exec inferno migrate
DOCKER_BUILDKIT=0 docker compose up -d
# nginx resolves the inferno upstream once at boot; if inferno is rebuilt/re-IP'd,
# `docker compose restart nginx` to clear a 502.

# start the auth-injecting proxy (binds 0.0.0.0 so the container reaches it)
PROXY_HOST=0.0.0.0 \
MEDPLUM_CLIENT_ID=<client-app-id> MEDPLUM_CLIENT_SECRET=<secret> \
node proxy/server.js
```

## Per-branch run

Point at whichever Medplum deployment (Lakebase branch) you want, then:

```sh
MEDPLUM_URL=https://<app-host>.databricksapps.com \
MEDPLUM_CLIENT_ID=<client-app-id> \
MEDPLUM_CLIENT_SECRET=<secret> \
DATABRICKS_PROFILE=FHIR \
bash run-comprehensive.sh
```

This fetches pinned reference data, loads the 5 US Core patient bundles,
generates gap-fillers, and runs the suite — writing raw results to
`results/us_core_v700_run_<timestamp>.json` and printing the tally.

`SKIP_LOAD=1` re-runs the suite only (data already present). To test the proxy
endpoint Inferno uses, override `FHIR_URL` (default
`http://host.docker.internal:3333/fhir/R4`).

## Secrets

No secret is ever written to disk. Credentials are passed via env only; the
loader/generator/runner send tokens in request headers/cookies at runtime.
Result JSONs contain request metadata but not the injected auth headers — scan
new artifacts before committing (see RESULTS.md).

## Branch targeting note

The deployed `medplum-server` app writes to the branch bound in its Databricks
Apps resource config (currently `projects/medplum/branches/production`). To run
against a different branch, point the app (or a second app) at that branch's
Lakebase database and set `MEDPLUM_URL` accordingly.
