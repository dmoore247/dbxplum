#!/bin/bash
#
# Run Full FHIR Compliance Test Suite
#
# This script demonstrates how to run the complete Inferno test suite
# against the Medplum FHIR server through the compliance proxy.
#
# Usage:
#   bash RUN_COMPLIANCE_TESTS.sh
#
# Prerequisites:
#   - Databricks CLI configured with FHIR profile
#   - Medplum credentials (optional, for data endpoint testing)
#   - Docker installed and running
#   - Node.js 14+
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$SCRIPT_DIR/proxy"
PROXY_PORT=3333
INFERNO_PORT=4567
FHIR_ENDPOINT="http://localhost:$PROXY_PORT/fhir/R4"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}"
cat << "EOF"
╔═════════════════════════════════════════════════════════════════╗
║                                                                 ║
║   FHIR Compliance Test Suite - Medplum on Databricks Apps       ║
║                                                                 ║
║   This script runs Inferno (ONC's official FHIR test kit)       ║
║   against the Medplum server through an auth-injecting proxy.   ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Function to check if a port is in use
port_in_use() {
    lsof -i :$1 > /dev/null 2>&1
}

# Function to wait for a service to be ready
wait_for_service() {
    local port=$1
    local service=$2
    local timeout=30
    local elapsed=0

    echo -e "${YELLOW}Waiting for $service to be ready (port $port)...${NC}"
    while ! curl -s http://localhost:$port > /dev/null 2>&1; do
        if [ $elapsed -ge $timeout ]; then
            echo -e "${RED}Timeout waiting for $service${NC}"
            return 1
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    echo -e "${GREEN}✓ $service is ready${NC}"
}

# Step 1: Check prerequisites
echo -e "\n${CYAN}Step 1: Checking Prerequisites${NC}"
echo -n "  Databricks CLI... "
if command -v databricks &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Not found${NC}"
    exit 1
fi

echo -n "  Node.js... "
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓${NC} ($NODE_VERSION)"
else
    echo -e "${RED}✗ Not found${NC}"
    exit 1
fi

echo -n "  Docker... "
if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Not found${NC}"
    echo -e "${YELLOW}  Note: Docker needed to run Inferno container${NC}"
fi

echo -n "  Databricks auth (FHIR profile)... "
if databricks auth token -p FHIR > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Failed to get token${NC}"
    echo -e "${YELLOW}  Check: databricks auth token -p FHIR${NC}"
    exit 1
fi

# Step 2: Check for port conflicts
echo -e "\n${CYAN}Step 2: Checking Available Ports${NC}"
echo -n "  Port $PROXY_PORT (proxy)... "
if port_in_use $PROXY_PORT; then
    echo -e "${RED}✗ In use${NC}"
    echo -e "${YELLOW}  Kill existing process: lsof -ti:$PROXY_PORT | xargs kill -9${NC}"
    exit 1
else
    echo -e "${GREEN}✓ Available${NC}"
fi

echo -n "  Port $INFERNO_PORT (Inferno)... "
if port_in_use $INFERNO_PORT; then
    echo -e "${YELLOW}⚠ In use (will stop existing)${NC}"
    docker-compose -f "$SCRIPT_DIR/docker-compose.yml" down 2>/dev/null || true
else
    echo -e "${GREEN}✓ Available${NC}"
fi

# Step 3: Start proxy
echo -e "\n${CYAN}Step 3: Starting Reverse Proxy${NC}"
cd "$PROXY_DIR"
node server.js > "$SCRIPT_DIR/proxy.log" 2>&1 &
PROXY_PID=$!
echo -e "${GREEN}✓ Proxy started (PID: $PROXY_PID)${NC}"
echo "  Logs: tail -f $SCRIPT_DIR/proxy.log"

# Wait for proxy to be ready
if ! wait_for_service $PROXY_PORT "Proxy"; then
    echo -e "${RED}Failed to start proxy${NC}"
    cat "$SCRIPT_DIR/proxy.log"
    exit 1
fi

# Verify proxy can reach Medplum
echo -n "  Testing Medplum connectivity... "
if curl -s "$FHIR_ENDPOINT/metadata" | jq '.resourceType' > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗${NC}"
    echo -e "${YELLOW}  Check proxy logs: tail -f $SCRIPT_DIR/proxy.log${NC}"
    kill $PROXY_PID 2>/dev/null || true
    exit 1
fi

# Step 4: Start Inferno
echo -e "\n${CYAN}Step 4: Starting Inferno${NC}"
cd "$SCRIPT_DIR"
docker-compose up -d inferno 2>&1 | tail -5
sleep 3

# Wait for Inferno to be ready
if ! wait_for_service $INFERNO_PORT "Inferno"; then
    echo -e "${RED}Failed to start Inferno${NC}"
    docker-compose logs inferno | tail -20
    kill $PROXY_PID 2>/dev/null || true
    exit 1
fi

# Step 5: Instructions
echo -e "\n${CYAN}Step 5: Running Tests${NC}"
echo -e "\n${GREEN}✓ Everything is ready!${NC}\n"

echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Open browser: ${CYAN}http://localhost:$INFERNO_PORT${NC}"
echo "  2. Select test suite (recommended: ${CYAN}US Core v7${NC})"
echo "  3. Enter FHIR endpoint: ${CYAN}$FHIR_ENDPOINT${NC}"
echo "  4. Leave auth empty (proxy handles it automatically)"
echo "  5. Click 'Run Tests' and wait for results"
echo

echo -e "${YELLOW}Monitoring:${NC}"
echo "  Proxy logs:    ${CYAN}tail -f $SCRIPT_DIR/proxy.log${NC}"
echo "  Inferno logs:  ${CYAN}docker-compose -f $SCRIPT_DIR/docker-compose.yml logs -f inferno${NC}"
echo

echo -e "${YELLOW}To stop everything:${NC}"
echo "  ${CYAN}bash $SCRIPT_DIR/STOP_TESTS.sh${NC}"
echo

echo -e "${YELLOW}Test Results:${NC}"
echo "  Results saved in: Inferno UI (http://localhost:$INFERNO_PORT)"
echo "  Export as: JSON or HTML via Inferno's export feature"
echo "  Save to: ${CYAN}tests/compliance/results/$(date +%Y%m%d_%H%M%S).json${NC}"
echo

echo -e "${BLUE}═════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Press Ctrl+C to stop monitoring logs${NC}"
echo -e "${BLUE}═════════════════════════════════════════════════════════════════${NC}\n"

# Step 6: Monitor (keep script running)
echo -e "${CYAN}Monitoring logs (Ctrl+C to exit):${NC}\n"

# Function to handle exit
cleanup() {
    echo -e "\n\n${YELLOW}Stopping services...${NC}"
    kill $PROXY_PID 2>/dev/null || true
    docker-compose -f "$SCRIPT_DIR/docker-compose.yml" down 2>/dev/null || true
    echo -e "${GREEN}✓ Services stopped${NC}"
    echo -e "\n${YELLOW}Note: Run ${CYAN}bash $SCRIPT_DIR/RUN_COMPLIANCE_TESTS.sh${YELLOW} to start again${NC}\n"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Show logs from proxy
tail -f "$SCRIPT_DIR/proxy.log" 2>/dev/null
