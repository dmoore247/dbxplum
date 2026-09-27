# Medplum FHIR R4 Performance Tests

Performance and load test suite for the Medplum FHIR R4 server running on Databricks Apps with Lakebase Postgres backing store.

## Overview

This test suite includes three scenarios:

- **Scenario A (Smoke)**: Sanity check and warm baseline
- **Scenario B (Read Baseline)**: Ramp load test with throughput/latency metrics
- **Scenario C (Authenticated Read/Write)**: Full FHIR ops with strict SLO thresholds

## Environment

- **App URL**: https://medplum-server-3464092709171785.aws.databricksapps.com
- **Backing Store**: Lakebase Autoscaling Postgres
- **Caching**: Redis co-located
- **Auth**: Two layers
  1. Databricks gateway (Bearer token)
  2. Medplum app (OAuth2 client_credentials for C)

## Prerequisites

- Docker installed (for k6 via `grafana/k6` image)
- `databricks` CLI configured with FHIR profile
- `jq` for JSON parsing
- Node.js 22+ (for local scripting, optional)

## Scenario Descriptions

### Scenario A: Smoke Test (1 VU, 30s)

**Endpoint**: GET `/fhir/R4/metadata`

**Purpose**: Verify endpoints are reachable, warm the Lakebase cache, capture cold-start latency.

**Thresholds**:
- p95 latency < 2s
- p99 latency < 3s
- Error rate < 10%

**Expected observations**:
- First request may show Lakebase wake latency (if compute was suspended)
- Subsequent requests should stabilize

---

### Scenario B: Read Baseline (1→20 VUs, 3.5 minutes)

**Endpoints**: GET `/fhir/R4/metadata`, GET `/healthcheck`

**Profile**:
- 0–30s: ramp to 1 VU
- 30s–2m: ramp to 20 VUs
- 2m–2.5m: hold at 20 VUs
- 2.5m–3m: ramp down

**Thresholds**:
- p50 latency < 500ms
- p95 latency < 1s
- p99 latency < 2s
- Error rate < 1%
- Sustained request rate > 10 req/s

**Expected observations**:
- Throughput ramp-up should be smooth if auto-scaling is enabled
- Lakebase CU scaling may introduce latency spikes during ramp phases
- Error rate should remain <1% under sustained load

---

### Scenario C: Authenticated Read/Write (1→25 VUs, ~5.5 minutes)

**Requires**: `MEDPLUM_CLIENT_ID` and `MEDPLUM_SECRET` env vars

**Endpoints**:
- GET `/fhir/R4/Patient?_count=10` (search)
- POST `/fhir/R4/Patient` (create)
- GET `/fhir/R4/metadata` (baseline)

**Profile**:
- 0–30s: ramp to 1 VU
- 30s–2.5m: ramp to 25 VUs
- 2.5m–4.5m: hold at 25 VUs
- 4.5m–5m: ramp down

**Thresholds**:
- p50 latency < 300ms
- p95 latency < 1s (strict SLO)
- p99 latency < 2s
- Error rate < 1%
- Sustained request rate > 20 req/s

**Setup**: Obtains Medplum OAuth token via client_credentials grant.

---

## Running Tests

### Quick Start (Scenarios A & B)

```bash
cd tests/perf
./run.sh
```

This will:
1. Fetch a fresh Databricks token (valid ~1h)
2. Verify endpoints are reachable
3. Run Scenario A (smoke)
4. Run Scenario B (read baseline)
5. Capture app logs before and after tests
6. Parse and display results in `results/`

**Runtime**: ~5 minutes

---

### Running Individual Scenarios

#### Scenario A (Smoke)

```bash
TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)
export DATABRICKS_TOKEN=$TOKEN
export APP_URL="https://medplum-server-3464092709171785.aws.databricksapps.com"

docker run --rm \
  -v $(pwd):/perf \
  -e DATABRICKS_TOKEN \
  -e APP_URL \
  grafana/k6:latest \
  run --out json=results/scenario-a.json /perf/scenario-a.js
```

#### Scenario B (Read Baseline)

```bash
docker run --rm \
  -v $(pwd):/perf \
  -e DATABRICKS_TOKEN \
  -e APP_URL \
  grafana/k6:latest \
  run --out json=results/scenario-b.json /perf/scenario-b.js
```

#### Scenario C (Authenticated Read/Write)

**Only run once credentials are available:**

```bash
export MEDPLUM_CLIENT_ID="<your_client_id>"
export MEDPLUM_SECRET="<your_client_secret>"

docker run --rm \
  -v $(pwd):/perf \
  -e DATABRICKS_TOKEN \
  -e APP_URL \
  -e MEDPLUM_CLIENT_ID \
  -e MEDPLUM_SECRET \
  grafana/k6:latest \
  run --out json=results/scenario-c.json /perf/scenario-c.js
```

---

## Results

Results are saved to `results/`:

- `scenario-{a,b,c}-results.json` – Raw k6 JSON metrics
- `scenario-{a,b,c}-summary.txt` – Human-readable summary (avg/p50/p95/p99 latency, error rate)
- `logs-baseline.txt` – App logs before tests
- `logs-post-test.txt` – App logs after tests

### Key Metrics

Each result includes:

- **Total Requests**: Raw count
- **Error Rate**: Percentage of failed requests
- **Latency**: avg, p50, p95, p99, max in milliseconds
- **Throughput**: Requests per second (implicit from req count / duration)

### Interpreting Results

- **p95 > 1s under load**: Possible Lakebase compute scaling lag or Redis contention
- **Error rate > 1%**: App or backing-store overload; check logs for specifics
- **p50 stable, p99 spikey**: Normal behavior under ramp; indicates scaling overhead
- **First request much slower**: Cold start; Lakebase compute was suspended or cached queries needed warmup

---

## Constraints & Best Practices

This is a shared FE workspace. Be a good citizen:

1. **Keep VUs reasonable**: Cap at 25 (Scenario C) for sustained load
2. **Keep duration short**: Ramp tests should be <5 minutes
3. **Space out runs**: If testing repeatedly, leave 5–10 minutes between runs for cooldown
4. **Monitor error logs**: Always check `logs-post-test.txt` for app-level issues
5. **Token expiry**: Databricks tokens expire ~1h; `run.sh` fetches a fresh one at start

---

## Architecture Notes

- **Lakebase Postgres**: Autoscaling compute; may show latency during CU scale-up/down
- **Redis**: Co-located with app; stores sessions, caches FHIR metadata
- **Medplum App**: Single LARGE instance; handles all three scenarios
- **Databricks Gateway**: Enforces Bearer token auth on all requests

---

## Troubleshooting

### "Failed to get Databricks token"
- Check `databricks auth tokens` are valid: `databricks auth token -p FHIR`
- Verify profile exists: `databricks config get --profile FHIR`

### "Connection refused" or "timeout"
- Verify app URL is correct and reachable: `curl -I https://medplum-server-...`
- Check Databricks token is still valid (expires ~1h)

### High error rate in Scenario B/C
- Check app logs: `databricks apps logs medplum-server -p FHIR`
- Look for Redis/Postgres connection errors
- Verify Lakebase compute is active: `databricks compute list`

### Scenario C setup fails
- Verify `MEDPLUM_CLIENT_ID` and `MEDPLUM_SECRET` are set: `echo $MEDPLUM_CLIENT_ID`
- Check OAuth endpoint is reachable: `curl -H "Authorization: Bearer $TOKEN" https://medplum-.../oauth2/token`

---

## Files

- `scenario-a.js` – Smoke test script
- `scenario-b.js` – Read baseline load test script
- `scenario-c.js` – Authenticated read/write load test script (template)
- `run.sh` – Bash runner script (executes A & B, captures logs)
- `README.md` – This file

---

## License

See parent repo LICENSE.
