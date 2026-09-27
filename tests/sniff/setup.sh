#!/bin/bash
#
# Helper script to set up environment variables for sniff tests
#
# Usage:
#   source tests/sniff/setup.sh
#   # Then run: node tests/sniff/sniff.mjs  or  bash tests/sniff/sniff.sh

echo "Setting up FHIR sniff test environment..."

# Get Databricks token
if [ -z "$DATABRICKS_TOKEN" ]; then
  echo "Obtaining Databricks token..."
  export DATABRICKS_TOKEN=$(databricks auth token -p FHIR 2>/dev/null | jq -r .access_token)
  if [ -z "$DATABRICKS_TOKEN" ]; then
    echo "ERROR: Failed to obtain Databricks token. Make sure:"
    echo "  - You have databricks CLI installed"
    echo "  - You have a FHIR profile configured"
    return 1 2>/dev/null || exit 1
  fi
  echo "✓ DATABRICKS_TOKEN set (expires in ~1 hour)"
else
  echo "✓ DATABRICKS_TOKEN already set"
fi

# Prompt for optional Medplum credentials
if [ -z "$MEDPLUM_CLIENT_ID" ] || [ -z "$MEDPLUM_CLIENT_SECRET" ]; then
  echo ""
  echo "Optional: Set Medplum credentials to run authenticated CRUD tests."
  echo "  (Leave blank to skip)"
  read -p "MEDPLUM_CLIENT_ID: " client_id
  if [ -n "$client_id" ]; then
    export MEDPLUM_CLIENT_ID="$client_id"
    read -sp "MEDPLUM_CLIENT_SECRET: " client_secret
    echo ""
    if [ -n "$client_secret" ]; then
      export MEDPLUM_CLIENT_SECRET="$client_secret"
      echo "✓ Medplum credentials set"
    fi
  fi
else
  echo "✓ Medplum credentials already set"
fi

# Custom URL
if [ -z "$MEDPLUM_URL" ]; then
  echo ""
  read -p "Custom MEDPLUM_URL (leave blank for default): " custom_url
  if [ -n "$custom_url" ]; then
    export MEDPLUM_URL="$custom_url"
    echo "✓ MEDPLUM_URL set to $MEDPLUM_URL"
  fi
fi

echo ""
echo "Environment ready! You can now run:"
echo "  node tests/sniff/sniff.mjs"
echo "  bash tests/sniff/sniff.sh"
