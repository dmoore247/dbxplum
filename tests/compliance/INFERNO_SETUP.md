# Running Inferno FHIR Compliance Tests

## What is Inferno?

**Inferno** is the ONC's (Office of the National Coordinator for Health IT) official FHIR conformance testing tool. It's a comprehensive test suite that validates FHIR servers against the FHIR R4 specification and US Core profiles.

- **Project**: https://github.com/inferno-framework/inferno
- **Docker Image**: `inferno-framework/inferno`
- **Latest Version**: Supports FHIR R4, US Core profiles (v3, v5, v6, v7)
- **UI**: Web-based interface on port 4567

## Quick Facts About Inferno

- **Open Source**: Apache 2.0 licensed
- **Test Suites Available**:
  - FHIR R4 Core compliance
  - US Core (multiple versions)
  - Patient Access (SMART on FHIR)
  - Bulk Data API
  - Da Vinci (CRD, HRex, etc.)
  - And more

- **How it works**:
  1. You specify a FHIR base URL (in our case, http://localhost:3333/fhir/R4)
  2. Inferno sends requests to that endpoint
  3. Validates responses against FHIR spec and selected profile
  4. Generates a test report with pass/fail/skip results

## Prerequisites

### Minimum Requirements
- **Docker** (recommended, simplest)
- OR: **Ruby** 2.7+, **Bundler**, local git clone

### For Our Setup
- **Proxy must be running**: `cd tests/compliance/proxy && node server.js`
- **Databricks CLI** configured (used by proxy)

## Method 1: Docker Compose (Recommended)

### Start Inferno

```bash
cd tests/compliance
docker-compose up -d inferno
```

Verify it's running:
```bash
docker ps | grep inferno
docker-compose logs inferno  # See startup logs
```

### Open Inferno Web UI

1. Open browser: **http://localhost:4567**
2. You should see Inferno homepage with available test suites

### Stop Inferno

```bash
docker-compose down
```

## Method 2: Direct Docker Run

If not using docker-compose:

```bash
docker run -d \
  --name inferno \
  -p 4567:4567 \
  inferno-framework/inferno:latest
```

Then open: **http://localhost:4567**

To stop:
```bash
docker stop inferno
docker rm inferno
```

## Method 3: Local Ruby Installation (Advanced)

If you prefer not to use Docker:

### 1. Clone Inferno

```bash
cd tests/compliance
git clone https://github.com/inferno-framework/inferno.git
cd inferno
```

### 2. Install Dependencies

```bash
gem install bundler
bundle install
```

### 3. Start Inferno

```bash
bundle exec puma -p 4567
```

### 4. Open Browser

Open: **http://localhost:4567**

## Using Inferno Web UI

### Step 1: Select Test Suite

From the homepage, click on a test suite. For Medplum compliance, use one of:
- **FHIR R4 Core** - Basic FHIR compliance
- **US Core v7** - Latest US Core profiles (recommended for Medplum)
- **US Core v5** - Earlier version if v7 has issues

### Step 2: Configure Endpoint

1. Enter FHIR Base URL: `http://localhost:3333/fhir/R4`
   - Note: Use `localhost`, not `127.0.0.1` (may matter for Docker networking)
   - Remove trailing slash
2. Select optional parameters if prompted
3. Click "Continue"

### Step 3: (Optional) Configure Auth

If the test suite requires auth configuration:
- **Client ID**: Leave blank (proxy handles bearer token auth)
- **Client Secret**: Leave blank
- **Bearer Token**: Leave blank (proxy injects Databricks token)
- **Use SMART Launch**: Typically "no" for direct testing

For Medplum credentials (when available):
- Contact your Medplum admin for client credentials
- These would be configured in Inferno separately

### Step 4: Run Tests

Click "Run Tests". Inferno will:
1. Contact the FHIR endpoint (through the proxy)
2. Fetch metadata (CapabilityStatement)
3. Run resource-specific tests
4. Display results in real-time

### Step 5: Review Results

- **Green**: Tests passed
- **Red**: Tests failed
- **Yellow**: Tests skipped (usually optional resources)
- **Blue**: Test info/context

Click on individual tests to see:
- Request details (URL, headers, body)
- Response (status, headers, body)
- Validation errors

### Step 6: Export Results

Use Inferno's export feature to save results as:
- JSON (machine-readable)
- HTML (human-readable report)
- Download test run

## Test Results Explained

### Metadata Tests (Always Run First)
- Fetches `GET /metadata`
- Validates CapabilityStatement structure
- **Expected with proxy**: ✅ PASS (metadata is public)

### Resource Search Tests
- Tests `GET /[Resource]?_count=1`
- **Expected with proxy only**: ❌ FAIL (401 Unauthorized - needs Medplum creds)
- **Expected with Medplum creds**: ✅ PASS

### Resource Read Tests
- Tests `GET /[Resource]/[id]`
- **Expected without data**: ❌ May vary (depends on test data)

### Resource Create Tests
- Tests `POST /[Resource]` with new resource
- Validates returned resource
- **Expected without Medplum write access**: ❌ FAIL

### Validation Tests
- Validates resource structure against FHIR spec
- Tests cardinality, data types, codes
- **Expected**: May vary by resource

## Troubleshooting

### "Connection refused" when running tests

```
Error: connect ECONNREFUSED 127.0.0.1:3333
```

**Fix**:
1. Make sure proxy is running: `curl http://localhost:3333/health`
2. If using Docker for Inferno:
   - Change URL to: `http://host.docker.internal:3333/fhir/R4` (macOS/Windows)
   - Or use `--network="host"` flag on Linux
3. Restart Inferno and re-enter URL

### "Invalid URL format"

**Fix**:
- Remove trailing slash: use `http://localhost:3333/fhir/R4` not `...R4/`
- Use full path with `/fhir/R4`
- Use `http://` not `https://` (proxy is local HTTP)

### Tests timeout or hang

**Fix**:
1. Proxy logs may show errors: check `proxy.log`
2. Databricks token may be expiring: restart proxy
3. Inferno timeout is usually ~10 seconds by default
4. Try running just metadata test first to verify connectivity

### 401 errors on all tests

**Expected** if you don't have Medplum credentials yet. This is normal.

**If you DO have credentials** and still get 401:
1. Verify Databricks token is working: `curl http://localhost:3333/fhir/R4/metadata`
2. Check proxy logs for auth errors
3. Medplum credentials may need to be configured differently

### "Socket hang up" or connection reset

**Fix**:
1. Proxy may have crashed: restart it
2. Databricks token refresh may be failing
3. Check Databricks CLI: `databricks auth token -p FHIR`
4. Verify internet connection to Databricks

## Understanding Test Profiles

### FHIR R4 Core

Tests compliance with FHIR R4 specification:
- Resource types
- Search parameters
- Operations
- Cardinality and data types

**Pass Rate Expectation**: Varies by resource and server implementation

### US Core v7

Tests US-specific FHIR profiles:
- Mandatory fields for US healthcare
- Common search parameters
- Must Support fields
- Binding requirements

**Medplum Support**: Medplum declares US Core v7 support in its CapabilityStatement

**Pass Rate Expectation**: 70-90% (depends on test data and permissions)

### Patient Access

Tests SMART on FHIR and Patient Launch:
- OAuth 2.0 / OIDC flow
- Scopes (patient vs. provider)
- App launch context

**Note**: Proxy doesn't support full SMART flow yet. Would need Medplum OAuth client setup.

## Advanced: Custom Test Suites

Inferno supports custom test definitions. To add custom tests:

```bash
cd tests/compliance/inferno/lib/inferno/suites
# Create custom_suite.rb with RSpec tests
```

See Inferno docs for examples: https://github.com/inferno-framework/inferno/wiki/Creating-Tests

## Performance Considerations

- **First run**: 2-5 minutes (fetches metadata, runs all tests)
- **Subsequent runs**: 30-60 seconds (may cache some data)
- **Large result sets**: May timeout if Patient/Observation searches return thousands of results
  - Configure Inferno's `_count` parameter if available
  - Or implement server-side pagination limits

## Next Steps

1. **Ensure proxy is running**:
   ```bash
   cd tests/compliance/proxy && node server.js
   ```

2. **Start Inferno**:
   ```bash
   docker-compose -f tests/compliance/docker-compose.yml up
   ```

3. **Open browser**: http://localhost:4567

4. **Run basic test**:
   - Select "FHIR R4 Core"
   - Enter: `http://localhost:3333/fhir/R4`
   - Click "Run Tests"

5. **Review results** and note any failures

6. **Once Medplum credentials available**:
   - Update proxy to inject Medplum token
   - Re-run full US Core v7 test suite
   - Export results for compliance documentation

---

**Questions?**
- Inferno docs: https://github.com/inferno-framework/inferno
- FHIR spec: https://www.hl7.org/fhir/
- Medplum docs: https://www.medplum.com/docs
