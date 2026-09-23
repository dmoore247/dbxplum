#!/bin/bash

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERF_DIR="$REPO_ROOT/tests/perf"
RESULTS_DIR="$PERF_DIR/results"

mkdir -p "$RESULTS_DIR"

# Get Databricks token
echo -e "${BLUE}Fetching Databricks token...${NC}"
TOKEN=$(databricks auth token -p FHIR 2>&1 | jq -r '.access_token')
if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
  echo -e "${RED}Failed to get Databricks token${NC}"
  exit 1
fi
echo -e "${GREEN}Token obtained (valid ~1h)${NC}"

APP_URL="https://medplum-server-3464092709171785.aws.databricksapps.com"

# Verify endpoints are reachable
echo -e "${BLUE}Verifying endpoints...${NC}"
HEALTH_CHECK=$(curl -s -H "Authorization: Bearer $TOKEN" "$APP_URL/healthcheck" | jq -r '.ok')
if [ "$HEALTH_CHECK" != "true" ]; then
  echo -e "${RED}Healthcheck failed${NC}"
  exit 1
fi
echo -e "${GREEN}Endpoints reachable${NC}"

# Function to run a scenario and capture results
run_scenario() {
  local scenario=$1
  local display_name=$2

  echo ""
  echo -e "${BLUE}=== Running Scenario ${scenario}: ${display_name} ===${NC}"

  local result_file="$RESULTS_DIR/scenario-${scenario}-results.json"

  # Run k6 via Docker
  docker run --rm \
    -v "$PERF_DIR:/perf" \
    -e DATABRICKS_TOKEN="$TOKEN" \
    -e APP_URL="$APP_URL" \
    grafana/k6:latest \
    run \
    --out "json=$result_file" \
    "/perf/scenario-${scenario}.js"

  echo -e "${GREEN}Scenario ${scenario} complete${NC}"

  # Parse and display summary
  parse_results "$result_file" "$scenario"
}

# Function to parse k6 JSON results and display summary
parse_results() {
  local result_file=$1
  local scenario=$2

  if [ ! -f "$result_file" ]; then
    echo -e "${RED}No results file found${NC}"
    return
  fi

  echo ""
  echo -e "${BLUE}--- Scenario ${scenario} Results ---${NC}"

  # Extract metrics using jq
  local total_reqs=$(jq '.metrics.http_reqs.values.count // 0' "$result_file")
  local failed_reqs=$(jq '.metrics.http_req_failed.values.rate // 0' "$result_file")
  local p50=$(jq '.metrics.http_req_duration.values["p(50)"] // 0' "$result_file")
  local p95=$(jq '.metrics.http_req_duration.values["p(95)"] // 0' "$result_file")
  local p99=$(jq '.metrics.http_req_duration.values["p(99)"] // 0' "$result_file")
  local avg=$(jq '.metrics.http_req_duration.values.avg // 0' "$result_file")
  local max=$(jq '.metrics.http_req_duration.values.max // 0' "$result_file")

  # Estimate throughput (requests per second)
  local duration_ms=$(jq '.state.testFinished // 0' "$result_file")
  local duration_s=$(echo "scale=2; $duration_ms / 1000" | bc 2>/dev/null || echo "N/A")

  echo "Total Requests:  $total_reqs"
  echo "Failed (rate):   $(printf '%.2f%%' $(echo "scale=2; $failed_reqs * 100" | bc 2>/dev/null || echo 0))"
  echo "Avg Latency:     ${avg}ms"
  echo "p50 Latency:     ${p50}ms"
  echo "p95 Latency:     ${p95}ms"
  echo "p99 Latency:     ${p99}ms"
  echo "Max Latency:     ${max}ms"

  # Also save human-readable summary
  cat > "$RESULTS_DIR/scenario-${scenario}-summary.txt" <<EOF
Scenario ${scenario} Results
=====================================
Total Requests:      $total_reqs
Error Rate:          $(printf '%.2f%%' $(echo "scale=2; $failed_reqs * 100" | bc 2>/dev/null || echo 0))
Avg Latency:         ${avg}ms
p50 Latency:         ${p50}ms
p95 Latency:         ${p95}ms
p99 Latency:         ${p99}ms
Max Latency:         ${max}ms

Full JSON results: scenario-${scenario}-results.json
EOF
}

# Capture baseline logs before tests
echo ""
echo -e "${BLUE}Capturing baseline app logs...${NC}"
databricks apps logs medplum-server -p FHIR --n 20 > "$RESULTS_DIR/logs-baseline.txt" 2>&1 || true

# Run both scenarios
run_scenario "a" "Smoke Test (1 VU, 30s)"
run_scenario "b" "Read Baseline (1→20 VUs ramp)"

# Capture post-test logs
echo ""
echo -e "${BLUE}Capturing post-test app logs...${NC}"
databricks apps logs medplum-server -p FHIR --n 50 > "$RESULTS_DIR/logs-post-test.txt" 2>&1 || true

echo ""
echo -e "${GREEN}All scenarios complete!${NC}"
echo -e "${BLUE}Results saved to: $RESULTS_DIR${NC}"
echo ""
echo "Summary files:"
ls -lh "$RESULTS_DIR"/*.txt "$RESULTS_DIR"/*.json 2>/dev/null | awk '{print $9, "(" $5 ")"}'
