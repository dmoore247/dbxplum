# Quick Start: Medplum Perf Tests

## What's Here

Performance test suite for Medplum FHIR R4 server on Databricks Apps.

**Status**: ✓ Scenarios A & B (smoke + ramp load) completed, 0% error rate

## Run Existing Tests (A & B)

```bash
cd tests/perf
./run.sh  # Requires: databricks CLI, jq, ~5 min runtime
```

Results → `results/scenario-{A,B}-{metrics.json,results.txt}`

## Files

| File | Purpose |
|------|---------|
| `scenario-a.js` | k6 smoke test (1 VU, 30s) |
| `scenario-b.js` | k6 ramp load (1→20 VUs) |
| `scenario-c.js` | k6 authenticated read/write (template) |
| `run.sh` | Bash harness (k6 via Docker) |
| `run-autocannon.js` | Node.js fallback harness (used for A & B) |
| `README.md` | Full documentation |
| `RESULTS.md` | Test results & analysis |
| `results/` | Test output (metrics, logs) |

## Key Results

### Scenario A (Smoke: 1 VU, 30s)
- **Throughput**: 5.98 req/s
- **p95 Latency**: 83ms
- **Error Rate**: 0%
- **Status**: ✓ Pass

### Scenario B (Ramp: 1→20 VUs, 2.5 min)
- **Throughput**: 85.28 req/s (avg across ramp)
- **p95 Latency**: 161ms
- **Error Rate**: 0%
- **Status**: ✓ Pass

## Run Scenario C (Authenticated CRUD)

Requires: `MEDPLUM_CLIENT_ID`, `MEDPLUM_SECRET` environment variables

```bash
export MEDPLUM_CLIENT_ID="<value>"
export MEDPLUM_SECRET="<value>"

TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)
export DATABRICKS_TOKEN=$TOKEN

docker run --rm \
  -v $(pwd):/perf \
  -e DATABRICKS_TOKEN \
  -e APP_URL="https://medplum-server-3464092709171785.aws.databricksapps.com" \
  -e MEDPLUM_CLIENT_ID \
  -e MEDPLUM_SECRET \
  grafana/k6:latest \
  run --out json=results/scenario-c.json /perf/scenario-c.js
```

Expected: ~5.5 min, 1→25 VUs ramp, mix of read/write/metadata operations.

## Run Individual k6 Tests

```bash
# Get token
TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)
export DATABRICKS_TOKEN=$TOKEN
export APP_URL="https://medplum-server-3464092709171785.aws.databricksapps.com"

# Scenario A
docker run --rm -v $(pwd):/perf -e DATABRICKS_TOKEN -e APP_URL grafana/k6:latest \
  run --out json=results/scenario-a.json /perf/scenario-a.js

# Scenario B
docker run --rm -v $(pwd):/perf -e DATABRICKS_TOKEN -e APP_URL grafana/k6:latest \
  run --out json=results/scenario-b.json /perf/scenario-b.js
```

## Constraints (Shared Workspace)

- **Max VUs**: 25
- **Max Duration**: 5–10 min per test
- **Wait Time**: 10 min between test runs (app cooldown)
- **Monitor**: Always check `databricks apps logs medplum-server -p FHIR` for errors

## Troubleshooting

### "Failed to get Databricks token"
```bash
databricks auth token -p FHIR  # Should return JSON with access_token
```

### "Connection refused"
- Check app URL: `curl -I https://medplum-server-3464092709171785.aws.databricksapps.com/healthcheck`
- Check auth: Token expires ~1h; re-run tests to fetch fresh token

### High error rate during test
```bash
# Check app logs
databricks apps logs medplum-server -p FHIR --tail-lines 100
```

Look for: connection pool exhaustion, Postgres timeouts, Redis eviction.

## Next Steps

1. Obtain Medplum OAuth credentials
2. Run Scenario C (authenticated CRUD)
3. For production testing: Install k6 locally (`brew install k6`) for full feature set
4. Scale up to 50+ VUs to find app ceiling

## References

- Full docs: `README.md`
- Results analysis: `RESULTS.md`
- App URL: https://medplum-server-3464092709171785.aws.databricksapps.com
- API: `/fhir/R4/{resourceType}/{id}`, `/healthcheck`, `/oauth2/token`
