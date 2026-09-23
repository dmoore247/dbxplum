#!/bin/bash
#
# FHIR Sniff Test for Medplum on Databricks Apps
#
# Quick smoke test verifying:
# 1. Gateway reachability + /healthcheck
# 2. FHIR Capability Statement fetch
# 3. Auth enforcement (401 without creds)
# 4. CRUD round-trip (if Medplum creds provided)
#
# Usage:
#   export DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)
#   ./sniff.sh
#
# With Medplum credentials:
#   export MEDPLUM_CLIENT_ID=<client_id>
#   export MEDPLUM_CLIENT_SECRET=<client_secret>
#   ./sniff.sh

set -e

BASE_URL="${MEDPLUM_URL:-https://medplum-server-3464092709171785.aws.databricksapps.com}"
DATABRICKS_TOKEN="${DATABRICKS_TOKEN}"
MEDPLUM_CLIENT_ID="${MEDPLUM_CLIENT_ID}"
MEDPLUM_CLIENT_SECRET="${MEDPLUM_CLIENT_SECRET}"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test result arrays
declare -a TESTS
declare -a STATUSES
declare -a CODES
declare -a NOTES

test_count=0

# Helper: Make HTTPS request
function curl_request() {
  local method=$1
  local path=$2
  local data=$3
  local medplum_token=$4
  local content_type=${5:-"application/json"}

  local headers=(
    "-H" "Accept: application/fhir+json"
    "-H" "Content-Type: $content_type"
  )

  if [ -n "$DATABRICKS_TOKEN" ]; then
    headers+=("-H" "Authorization: Bearer $DATABRICKS_TOKEN")
  fi

  if [ -n "$medplum_token" ]; then
    headers+=("-H" "Cookie: __medplum_token=$medplum_token")
  fi

  if [ -n "$data" ]; then
    headers+=("-d" "$data")
  fi

  curl -s -w "\n%{http_code}" \
    -X "$method" \
    "${headers[@]}" \
    "$BASE_URL$path"
}

# Helper: Record test result
function record_result() {
  local test_name=$1
  local status=$2
  local code=$3
  local notes=$4

  TESTS+=("$test_name")
  STATUSES+=("$status")
  CODES+=("$code")
  NOTES+=("$notes")
  test_count=$((test_count + 1))
}

# Helper: Extract JSON from curl response (removes HTTP code)
function extract_json() {
  local response=$1
  # Remove last line (HTTP code) and return the rest
  echo "$response" | sed '$d'
}

# Helper: Extract HTTP code from curl response
function extract_code() {
  local response=$1
  # Get last line
  echo "$response" | tail -1
}

echo "Starting FHIR Sniff Test..."
echo ""
echo "Base URL: $BASE_URL"
echo "Databricks Token: ${DATABRICKS_TOKEN:0:20}..."
echo "Medplum Creds: ${MEDPLUM_CLIENT_ID:-Missing}"
echo ""

# Test 1: Healthcheck
echo -n "Test 1: Healthcheck... "
response=$(curl_request GET "/healthcheck" "" "" "application/json")
code=$(extract_code "$response")
body=$(extract_json "$response")

if [ "$code" = "200" ]; then
  postgres=$(echo "$body" | jq -r '.postgres // empty' 2>/dev/null)
  redis=$(echo "$body" | jq -r '.redis // empty' 2>/dev/null)
  if [ "$postgres" = "true" ] && [ "$redis" = "true" ]; then
    echo -e "${GREEN}PASS${NC} (200)"
    record_result "1. Healthcheck" "PASS" "$code" "postgres=true, redis=true"
  else
    echo -e "${RED}FAIL${NC} ($code)"
    record_result "1. Healthcheck" "FAIL" "$code" "postgres=$postgres, redis=$redis"
  fi
else
  echo -e "${RED}FAIL${NC} ($code)"
  record_result "1. Healthcheck" "FAIL" "$code" "Expected 200"
fi

# Test 2: FHIR Capability Statement
echo -n "Test 2: GET /fhir/R4/metadata... "
response=$(curl_request GET "/fhir/R4/metadata" "" "" "application/json")
code=$(extract_code "$response")
body=$(extract_json "$response")

if [ "$code" = "200" ]; then
  resource_type=$(echo "$body" | jq -r '.resourceType // empty' 2>/dev/null)
  if [ "$resource_type" = "CapabilityStatement" ]; then
    fhir_version=$(echo "$body" | jq -r '.fhirVersion // "unknown"' 2>/dev/null)
    software_version=$(echo "$body" | jq -r '.software.version // "unknown"' 2>/dev/null)
    echo -e "${GREEN}PASS${NC} (200)"
    record_result "2. GET /fhir/R4/metadata" "PASS" "$code" "fhirVersion=$fhir_version, software=$software_version"
  else
    echo -e "${RED}FAIL${NC} ($code)"
    record_result "2. GET /fhir/R4/metadata" "FAIL" "$code" "Expected CapabilityStatement, got $resource_type"
  fi
else
  echo -e "${RED}FAIL${NC} ($code)"
  record_result "2. GET /fhir/R4/metadata" "FAIL" "$code" "Expected 200"
fi

# Test 3: Auth Enforcement
echo -n "Test 3: Auth Enforcement (GET /fhir/R4/Patient without token)... "
response=$(curl_request GET "/fhir/R4/Patient" "" "" "application/json")
code=$(extract_code "$response")

if [ "$code" = "401" ]; then
  echo -e "${GREEN}PASS${NC} (401)"
  record_result "3. Auth Enforcement" "PASS" "$code" "Correctly rejected unauthenticated request"
elif [ "$code" = "200" ]; then
  echo -e "${RED}FAIL${NC} ($code)"
  record_result "3. Auth Enforcement" "FAIL" "$code" "Expected 401 but got 200 (auth not enforced)"
else
  echo -e "${RED}FAIL${NC} ($code)"
  record_result "3. Auth Enforcement" "FAIL" "$code" "Expected 401"
fi

# Test 4+: CRUD tests (only if Medplum creds are provided)
if [ -n "$MEDPLUM_CLIENT_ID" ] && [ -n "$MEDPLUM_CLIENT_SECRET" ]; then
  echo ""
  echo "Medplum credentials found, running authenticated CRUD tests..."
  echo ""

  # Obtain Medplum token
  echo -n "Test 4: OAuth2 Token Acquisition... "
  token_response=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $DATABRICKS_TOKEN" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials&client_id=$MEDPLUM_CLIENT_ID&client_secret=$MEDPLUM_CLIENT_SECRET" \
    "$BASE_URL/oauth2/token")

  code=$(echo "$token_response" | tail -1)
  body=$(echo "$token_response" | sed '$d')

  if [ "$code" = "200" ]; then
    medplum_token=$(echo "$body" | jq -r '.access_token // empty' 2>/dev/null)
    if [ -n "$medplum_token" ]; then
      echo -e "${GREEN}PASS${NC} (200)"
      record_result "4. OAuth2 Token Acquisition" "PASS" "$code" "Token obtained"
    else
      echo -e "${RED}FAIL${NC} ($code)"
      record_result "4. OAuth2 Token Acquisition" "FAIL" "$code" "No access_token in response"
      medplum_token=""
    fi
  else
    echo -e "${RED}FAIL${NC} ($code)"
    record_result "4. OAuth2 Token Acquisition" "FAIL" "$code" "Expected 200"
    medplum_token=""
  fi

  if [ -n "$medplum_token" ]; then
    # Test 5: Create Patient
    echo -n "Test 5: CRUD Create Patient (POST)... "
    patient_payload='{"resourceType":"Patient","name":[{"given":["Test"],"family":"Sniff"}],"telecom":[{"system":"email","value":"sniff@test.local"}]}'
    response=$(curl_request POST "/fhir/R4/Patient" "$patient_payload" "$medplum_token" "application/json")
    code=$(extract_code "$response")
    body=$(extract_json "$response")

    if [ "$code" = "201" ] || [ "$code" = "200" ]; then
      patient_id=$(echo "$body" | jq -r '.id // empty' 2>/dev/null)
      if [ -n "$patient_id" ]; then
        echo -e "${GREEN}PASS${NC} ($code)"
        record_result "5. CRUD Create Patient" "PASS" "$code" "Created id=$patient_id"
      else
        echo -e "${RED}FAIL${NC} ($code)"
        record_result "5. CRUD Create Patient" "FAIL" "$code" "No id in response"
        patient_id=""
      fi
    else
      echo -e "${RED}FAIL${NC} ($code)"
      record_result "5. CRUD Create Patient" "FAIL" "$code" "Expected 200/201"
      patient_id=""
    fi

    if [ -n "$patient_id" ]; then
      # Test 6: Read Patient
      echo -n "Test 6: CRUD Read Patient (GET)... "
      response=$(curl_request GET "/fhir/R4/Patient/$patient_id" "" "$medplum_token" "application/json")
      code=$(extract_code "$response")
      body=$(extract_json "$response")

      if [ "$code" = "200" ]; then
        read_id=$(echo "$body" | jq -r '.id // empty' 2>/dev/null)
        if [ "$read_id" = "$patient_id" ]; then
          echo -e "${GREEN}PASS${NC} (200)"
          record_result "6. CRUD Read Patient" "PASS" "$code" "Read patient"
        else
          echo -e "${RED}FAIL${NC} ($code)"
          record_result "6. CRUD Read Patient" "FAIL" "$code" "ID mismatch"
        fi
      else
        echo -e "${RED}FAIL${NC} ($code)"
        record_result "6. CRUD Read Patient" "FAIL" "$code" "Expected 200"
      fi

      # Test 7: Update Patient
      echo -n "Test 7: CRUD Update Patient (PUT)... "
      update_payload="{\"resourceType\":\"Patient\",\"id\":\"$patient_id\",\"name\":[{\"given\":[\"Test\",\"Updated\"],\"family\":\"Sniff\"}]}"
      response=$(curl_request PUT "/fhir/R4/Patient/$patient_id" "$update_payload" "$medplum_token" "application/json")
      code=$(extract_code "$response")

      if [ "$code" = "200" ] || [ "$code" = "204" ]; then
        echo -e "${GREEN}PASS${NC} ($code)"
        record_result "7. CRUD Update Patient" "PASS" "$code" "Updated patient"
      else
        echo -e "${RED}FAIL${NC} ($code)"
        record_result "7. CRUD Update Patient" "FAIL" "$code" "Expected 200/204"
      fi

      # Test 8: Search Patient
      echo -n "Test 8: CRUD Search Patient (GET ?family=)... "
      response=$(curl_request GET "/fhir/R4/Patient?family=Sniff" "" "$medplum_token" "application/json")
      code=$(extract_code "$response")
      body=$(extract_json "$response")

      if [ "$code" = "200" ]; then
        resource_type=$(echo "$body" | jq -r '.resourceType // empty' 2>/dev/null)
        if [ "$resource_type" = "Bundle" ]; then
          count=$(echo "$body" | jq -r '.entry | length // 0' 2>/dev/null)
          echo -e "${GREEN}PASS${NC} (200)"
          record_result "8. CRUD Search Patient" "PASS" "$code" "Found $count patient(s)"
        else
          echo -e "${RED}FAIL${NC} ($code)"
          record_result "8. CRUD Search Patient" "FAIL" "$code" "Expected Bundle"
        fi
      else
        echo -e "${RED}FAIL${NC} ($code)"
        record_result "8. CRUD Search Patient" "FAIL" "$code" "Expected 200"
      fi

      # Test 9: Version History
      echo -n "Test 9: CRUD Version History (GET _history)... "
      response=$(curl_request GET "/fhir/R4/Patient/$patient_id/_history" "" "$medplum_token" "application/json")
      code=$(extract_code "$response")
      body=$(extract_json "$response")

      if [ "$code" = "200" ]; then
        resource_type=$(echo "$body" | jq -r '.resourceType // empty' 2>/dev/null)
        if [ "$resource_type" = "Bundle" ]; then
          count=$(echo "$body" | jq -r '.entry | length // 0' 2>/dev/null)
          echo -e "${GREEN}PASS${NC} (200)"
          record_result "9. CRUD Version History" "PASS" "$code" "Found $count version(s)"
        else
          echo -e "${RED}FAIL${NC} ($code)"
          record_result "9. CRUD Version History" "FAIL" "$code" "Expected Bundle"
        fi
      else
        echo -e "${RED}FAIL${NC} ($code)"
        record_result "9. CRUD Version History" "FAIL" "$code" "Expected 200"
      fi

      # Test 10: Delete Patient
      echo -n "Test 10: CRUD Delete Patient (DELETE)... "
      response=$(curl_request DELETE "/fhir/R4/Patient/$patient_id" "" "$medplum_token" "application/json")
      code=$(extract_code "$response")

      if [ "$code" = "200" ] || [ "$code" = "204" ] || [ "$code" = "202" ]; then
        echo -e "${GREEN}PASS${NC} ($code)"
        record_result "10. CRUD Delete Patient" "PASS" "$code" "Deleted patient"
      else
        echo -e "${RED}FAIL${NC} ($code)"
        record_result "10. CRUD Delete Patient" "FAIL" "$code" "Expected 200/204/202"
      fi
    else
      # Skip remaining CRUD tests if create failed
      for i in 6 7 8 9 10; do
        record_result "$i. CRUD (skipped)" "SKIP" "-" "Create patient failed"
      done
    fi
  else
    # Skip remaining tests if token acquisition failed
    for i in 5 6 7 8 9 10; do
      record_result "$i. CRUD (skipped)" "SKIP" "-" "Token acquisition failed"
    done
  fi
else
  # No Medplum creds provided, skip authenticated tests
  record_result "4. OAuth2 Token Acquisition" "SKIP" "-" "MEDPLUM_CLIENT_ID/SECRET not set"
  for i in 5 6 7 8 9 10; do
    record_result "$i. CRUD (skipped)" "SKIP" "-" "Medplum credentials not available"
  done
fi

# Print summary table
echo ""
echo "====================================================================================================="
echo "FHIR SNIFF TEST SUMMARY"
echo "====================================================================================================="
echo "URL: $BASE_URL"
echo "Databricks Token: ${DATABRICKS_TOKEN:+✓ Present}${DATABRICKS_TOKEN:- ✗ Missing}"
echo "Medplum Creds: ${MEDPLUM_CLIENT_ID:+✓ Present}${MEDPLUM_CLIENT_ID:- ✗ Missing}"
echo "====================================================================================================="
printf "%-45s %-10s %-8s Notes\n" "Step" "Status" "Code"
echo "-----------------------------------------------------------------------------------------------------"

pass_count=0
fail_count=0
skip_count=0

for i in $(seq 0 $((test_count - 1))); do
  status="${STATUSES[$i]}"
  if [ "$status" = "PASS" ]; then
    status_colored="${GREEN}${status}${NC}"
    pass_count=$((pass_count + 1))
  elif [ "$status" = "FAIL" ]; then
    status_colored="${RED}${status}${NC}"
    fail_count=$((fail_count + 1))
  else
    status_colored="${YELLOW}${status}${NC}"
    skip_count=$((skip_count + 1))
  fi

  code="${CODES[$i]}"
  code_str="${code:--}"
  notes="${NOTES[$i]:0:37}"

  printf "%-45s %-10s %-8s %s\n" "${TESTS[$i]}" "$(echo -e "$status_colored")" "$code_str" "$notes"
done

echo "====================================================================================================="
echo "TOTAL: $pass_count passed, $fail_count failed, $skip_count skipped"

if [ $fail_count -eq 0 ]; then
  echo -e "${GREEN}RESULT: ✓ ALL TESTS PASSED${NC}"
  exit 0
else
  echo -e "${RED}RESULT: ✗ SOME TESTS FAILED${NC}"
  exit 1
fi
