# FHIR Compliance Testing Setup

This directory contains infrastructure for running industry-standard FHIR compliance tests (Inferno by ONC) against the Medplum FHIR R4 server running on Databricks Apps.

## Architecture Overview

The Medplum server at `https://medplum-server-3464092709171785.aws.databricksapps.com/fhir/R4` is behind a **Databricks OAuth gateway** that requires an `Authorization: Bearer <databricks-token>` header on every request. Standard FHIR test tools like Inferno cannot easily inject dynamic bearer tokens.

**Solution**: A lightweight Node.js **reverse proxy** (`proxy/server.js`) that:
- Listens locally on `http://localhost:3333`
- Automatically refreshes Databricks auth tokens (valid for ~1 hour)
- Injects the token on every proxied request
- Forwards all traffic to the real FHIR server

This allows **Inferno to connect to `http://localhost:3333/fhir/R4`** as if it were an unprotected endpoint, while the proxy handles all Databricks OAuth transparently.

```
Inferno (http://localhost:4567)
    ↓ (FHIR requests to http://localhost:3333/fhir/R4)
Reverse Proxy (localhost:3333, injects Databricks token)
    ↓ (HTTPS + Authorization header)
Medplum FHIR Server (AWS Databricks Apps)
```

## Prerequisites

1. **Databricks CLI** configured with access to the FHIR workspace
   - Verify: `databricks auth token -p FHIR` should return a token
   - Token must exist for profile named `FHIR` in `~/.databrickscfg`

2. **Node.js 14+** (included in repo environment)
   - Verify: `node --version`

3. **Docker** (for running Inferno)
   - Verify: `docker --version`

4. **Medplum server credentials** (needed for full compliance testing)
   - These will be provided separately and injected into proxy as `MEDPLUM_TOKEN` env var
   - For now, metadata + unauthenticated endpoints work through the proxy

## Quick Start (Proxy Only - No Medplum Auth Yet)

### 1. Start the Reverse Proxy

```bash
cd tests/compliance/proxy
node server.js
```

Expected output:
```
╔═══════════════════════════════════════════════════════════╗
║  FHIR Compliance Proxy                                    ║
╠═══════════════════════════════════════════════════════════╣
║  Listening on: http://127.0.0.1:3333
║  Target FHIR server: https://medplum-server-3464092709171785.aws.databricksapps.com
║  FHIR base path: /fhir/R4
║  Health check: http://127.0.0.1:3333/health
╚═══════════════════════════════════════════════════════════╝
```

### 2. Verify Proxy Works

In another terminal:

```bash
# Health check
curl http://localhost:3333/health

# Metadata endpoint (should return CapabilityStatement)
curl http://localhost:3333/fhir/R4/metadata | jq '.resourceType'
# Should output: "CapabilityStatement"
```

## Full Compliance Testing Workflow (Requires Medplum Creds)

Once Medplum credentials are provided:

### 1. Set Medplum Token (if needed)

```bash
# If Medplum requires client_credentials token injection:
export MEDPLUM_TOKEN="<your-medplum-token>"
```

Or add to `tests/compliance/.env`:
```bash
MEDPLUM_TOKEN=your_token_here
```

Then restart proxy:
```bash
cd tests/compliance/proxy
node server.js
```

### 2. Start Proxy

```bash
cd tests/compliance/proxy
node server.js

# Runs in foreground. To run in background:
# node server.js > proxy.log 2>&1 &
```

### 3. Start Inferno

#### Option A: Docker Compose (Recommended)

```bash
cd tests/compliance
docker-compose up -d inferno
```

Then open browser: **http://localhost:4567**

To see logs:
```bash
docker-compose logs -f inferno
```

To stop:
```bash
docker-compose down
```

#### Option B: Docker Run (Manual)

```bash
docker run -d \
  --name inferno-fhir \
  -p 4567:4567 \
  -e FHIR_ENDPOINT="http://host.docker.internal:3333/fhir/R4" \
  inferno-framework/inferno:latest

# Open browser to http://localhost:4567
```

To stop:
```bash
docker stop inferno-fhir
docker rm inferno-fhir
```

### 4. Configure and Run Tests in Inferno Web UI

1. Open **http://localhost:4567** in browser
2. Select a test suite:
   - **FHIR R4 Core** - Basic FHIR R4 compliance
   - **US Core** - US-specific FHIR profiles (Medplum supports this)
3. Enter FHIR endpoint: `http://localhost:3333/fhir/R4`
   - Note: Leave off trailing slash
4. If prompted for auth:
   - Auth method: "Bearer Token" or "None" (proxy handles it)
   - Token: (leave blank - proxy injects Databricks token automatically)
5. For confidential client tests (if Medplum requires it):
   - Client ID: (provided separately)
   - Client Secret: (provided separately)
6. Click "Run Tests"

### 5. Review Results

- Inferno displays results in real-time
- Test results are saved locally (check `docker` volume or Inferno UI)
- Export results as JSON/HTML via Inferno's export feature

## Proxy Configuration

### Environment Variables

```bash
PROXY_PORT=3333                    # Port to listen on (default: 3333)
TARGET_URL=<app-url>              # Target FHIR server URL
                                    # Default: https://medplum-server-3464092709171785.aws.databricksapps.com
MEDPLUM_TOKEN=<token>              # Medplum auth token (optional, for future use)
```

### How the Proxy Works

1. **Databricks Token Refresh**:
   - Calls `databricks auth token -p FHIR` before each request
   - Caches token for 55 minutes (refreshes before 1-hour expiry)
   - Falls back to cached token if refresh fails

2. **Request Forwarding**:
   - Intercepts all HTTP requests to `localhost:3333/*`
   - Adds `Authorization: Bearer <databricks-token>` header
   - Forwards to target FHIR server
   - Streams response back to client

3. **CORS Support**:
   - Proxy allows browser-based FHIR clients (Inferno UI)
   - Adds CORS headers to all responses

## Testing the Proxy Directly

Without Inferno, you can test FHIR endpoints through the proxy:

```bash
# Metadata (no auth required)
curl http://localhost:3333/fhir/R4/metadata | jq '.software.version'

# Search Patients (requires Medplum credentials)
curl http://localhost:3333/fhir/R4/Patient?_count=10

# Create a Patient (requires Medplum credentials)
curl -X POST http://localhost:3333/fhir/R4/Patient \
  -H "Content-Type: application/fhir+json" \
  -d '{"resourceType":"Patient","name":[{"given":["John"],"family":"Doe"}]}'
```

## Troubleshooting

### Proxy won't start

**Error**: `databricks auth token: command not found`
- **Fix**: Ensure `databricks` CLI is installed and in PATH
- Verify: `which databricks`

**Error**: `Error: EADDRINUSE: address already in use :::3333`
- **Fix**: Another process is using port 3333
- Kill it: `lsof -ti:3333 | xargs kill -9`
- Or use different port: `PROXY_PORT=3334 node server.js`

### Proxy gets 401/403 from Inferno

**Error**: Metadata returns 401 (Unauthorized)
- **Fix**: Databricks token may have expired
- The proxy auto-refreshes, but if it fails:
  - Stop proxy, verify CLI works: `databricks auth token -p FHIR`
  - Check `~/.databrickscfg` has profile `[FHIR]`
  - Restart proxy

### Inferno can't connect to proxy

**Error**: "Connection refused" in Inferno
- **Fix**: Ensure proxy is running: `curl http://localhost:3333/health`
- If using Docker, use `host.docker.internal:3333` not `localhost:3333`
- On Linux, use `--network="host"` instead of port mapping

### Inferno tests timeout

**Error**: "Request timeout" during test run
- **Fix**: Databricks request may be slow
  - Increase timeout in Inferno if available
  - Or run during off-peak hours

### Medplum server returns 403 even through proxy

**Error**: All requests get 403 Forbidden
- **Fix**: Databricks token is valid, but Medplum auth is missing
  - This is expected without Medplum credentials
  - Metadata endpoint should still work (doesn't require Medplum auth)
  - Once Medplum credentials provided, set `MEDPLUM_TOKEN` env var

## Alternative: Touchstone (AEGIS)

For reference, **Touchstone** (by AEGIS) is another industry standard for FHIR testing:
- Web-based (no local setup needed)
- URL: https://touchstone.aegis.net/touchstone/
- Pros: Simpler UI, no infrastructure needed
- Cons: Must expose FHIR server to internet, less control
- Good for: Validation after local testing

To use Touchstone, the Medplum server endpoint would need to be:
1. Accessible from the internet (or Touchstone's IP whitelisted)
2. Not behind Databricks OAuth (would need to modify gateway)

For now, Inferno + local proxy is the better approach.

## Advanced: Extending the Proxy

### Adding Medplum Token Support

Once Medplum credentials are provided, modify `proxy/server.js`:

```javascript
// In proxyRequest() function, after Databricks token:
const medplumToken = getMedplumToken();
if (medplumToken) {
  targetReqHeaders['X-Medplum-Auth'] = medplumToken;
  // Or: targetReqHeaders['X-Medplum-Client-Id'] = '...';
}
```

### Monitoring / Logging

The proxy logs all requests:
```
[proxy] GET /fhir/R4/Patient?_count=5
[proxy] Using cached Databricks token (expires in 1234s)
[proxy] 200 OK - 2.5s
```

For production, pipe to file:
```bash
node server.js >> proxy.log 2>&1 &
tail -f proxy.log
```

### Performance Tuning

- **Token refresh rate**: Currently 5-minute cache with 55-minute expiry threshold
- **Connection pooling**: Node.js HTTP agent could be tuned
- **Request timeout**: Set via `targetReq.setTimeout()`

## Contact & Questions

- **Proxy issues**: Check `/tests/compliance/proxy/server.js` - well-commented
- **Inferno config**: See Inferno docs: https://github.com/inferno-framework/inferno
- **FHIR questions**: See https://www.hl7.org/fhir/overview.html

---

**Status**: Proxy ✅ Running and tested. Inferno ✅ Ready to run. Full compliance tests 🔄 Waiting for Medplum credentials.
