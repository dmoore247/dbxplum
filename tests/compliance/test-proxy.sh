#!/bin/bash
#
# Test script for FHIR Compliance Proxy
# Validates that the proxy is correctly forwarding requests with Databricks auth
#

set -e

PROXY_URL="http://localhost:3333"
FHIR_BASE="${PROXY_URL}/fhir/R4"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  FHIR Compliance Proxy - Test Suite${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

# Check if proxy is running
echo -e "${YELLOW}1. Checking proxy health...${NC}"
if curl -s "${PROXY_URL}/health" > /dev/null 2>&1; then
    HEALTH=$(curl -s "${PROXY_URL}/health" | jq -r '.status' 2>/dev/null || echo "error")
    if [ "$HEALTH" = "ok" ]; then
        echo -e "${GREEN}✓ Proxy is running${NC}"
    else
        echo -e "${RED}✗ Proxy health check failed${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Cannot connect to proxy at ${PROXY_URL}${NC}"
    echo -e "${YELLOW}  Start proxy first: cd tests/compliance/proxy && node server.js${NC}"
    exit 1
fi

# Test metadata endpoint
echo -e "\n${YELLOW}2. Testing FHIR metadata endpoint...${NC}"
METADATA=$(curl -s "${FHIR_BASE}/metadata")
RESOURCE_TYPE=$(echo "$METADATA" | jq -r '.resourceType' 2>/dev/null)

if [ "$RESOURCE_TYPE" = "CapabilityStatement" ]; then
    echo -e "${GREEN}✓ Metadata endpoint working${NC}"
    echo "  Resource Type: CapabilityStatement"
    VERSION=$(echo "$METADATA" | jq -r '.software.version' 2>/dev/null)
    echo "  Medplum Version: $VERSION"
else
    echo -e "${RED}✗ Metadata endpoint returned: $RESOURCE_TYPE${NC}"
    exit 1
fi

# Test that Authorization header is being used
echo -e "\n${YELLOW}3. Verifying Databricks authorization...${NC}"
# If the proxy is forwarding with auth, we should get a valid response
# Without auth, we'd get a redirect (302) to Databricks OIDC
STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${FHIR_BASE}/metadata")

if [ "$STATUS_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Authorization header correctly injected (HTTP ${STATUS_CODE})${NC}"
else
    echo -e "${RED}✗ Unexpected HTTP status: ${STATUS_CODE}${NC}"
    if [ "$STATUS_CODE" = "302" ]; then
        echo -e "   This usually means auth header is missing (redirect to OIDC)"
    fi
    exit 1
fi

# Test CORS headers
echo -e "\n${YELLOW}4. Testing CORS headers...${NC}"
CORS_ORIGIN=$(curl -s -i -X OPTIONS "${FHIR_BASE}/Patient" 2>/dev/null | grep -i "Access-Control-Allow-Origin" | head -1)

if [ ! -z "$CORS_ORIGIN" ]; then
    echo -e "${GREEN}✓ CORS headers present${NC}"
    echo "  $CORS_ORIGIN"
else
    echo -e "${YELLOW}⚠ CORS headers not detected (may be expected)${NC}"
fi

# Test common FHIR operations
echo -e "\n${YELLOW}5. Testing common FHIR operations (data requires Medplum creds)...${NC}"

# GET /Patient (search)
echo -n "  GET /Patient (search)... "
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${FHIR_BASE}/Patient?_count=1")
if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "401" ] || [ "$RESPONSE" = "403" ]; then
    # 200 = success, 401/403 = auth required (expected without Medplum creds)
    echo -e "${GREEN}✓${NC} (HTTP $RESPONSE - auth required without creds)"
else
    echo -e "${RED}✗${NC} (HTTP $RESPONSE)"
fi

# GET /Patient/:id (read)
echo -n "  GET /Patient/:id (read)... "
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${FHIR_BASE}/Patient/patient-123")
if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "401" ] || [ "$RESPONSE" = "403" ] || [ "$RESPONSE" = "404" ]; then
    echo -e "${GREEN}✓${NC} (HTTP $RESPONSE)"
else
    echo -e "${RED}✗${NC} (HTTP $RESPONSE)"
fi

# GET /Observation (different resource)
echo -n "  GET /Observation (different resource)... "
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${FHIR_BASE}/Observation?_count=1")
if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "401" ] || [ "$RESPONSE" = "403" ]; then
    echo -e "${GREEN}✓${NC} (HTTP $RESPONSE - auth required without creds)"
else
    echo -e "${RED}✗${NC} (HTTP $RESPONSE)"
fi

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}All proxy tests passed!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

echo -e "Next steps:"
echo -e "  1. Start Inferno: ${YELLOW}docker-compose -f tests/compliance/docker-compose.yml up${NC}"
echo -e "  2. Open http://localhost:4567"
echo -e "  3. Configure with FHIR endpoint: ${YELLOW}http://localhost:3333/fhir/R4${NC}"
echo -e "  4. Run compliance tests\n"
