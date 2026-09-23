# Implementation Notes - FHIR Compliance Testing Setup

## What Was Built

This compliance testing infrastructure enables Inferno (ONC's official FHIR test tool) to test the Medplum FHIR R4 server running on Databricks Apps, despite the server being protected by a Databricks OAuth gateway.

## Architecture Decision: Why Reverse Proxy?

### Problem
- Medplum server is behind Databricks OAuth gateway
- Every request must include: `Authorization: Bearer <databricks-token>`
- Token expires ~1 hour
- Databricks redirects unauthenticated requests to OIDC login (302)
- Inferno cannot easily inject custom bearer tokens on every request

### Solutions Evaluated

| Approach | Pros | Cons | Status |
|----------|------|------|--------|
| **A: Configure Inferno with static token** | Simple, no extra infrastructure | Inferno doesn't support custom bearer header injection for all requests | ❌ Not viable |
| **B: Reverse Proxy (chosen)** | Clean separation, transparent to Inferno, handles token refresh, reusable | Extra service to manage | ✅ Implemented |
| **C: Local Medplum (Docker)** | Tests local not deployed server | Doesn't test actual deployment | ⚠️ Fallback option |
| **D: Modify Databricks gateway** | Most "native" solution | Changes to enterprise auth infrastructure | ❌ Out of scope |

**Chosen**: **Option B - Reverse Proxy** because:
1. Proxy is invisible to Inferno (it just sees a regular HTTP FHIR endpoint)
2. Token refresh is handled automatically (~55 min cache, refresh at 5 min before expiry)
3. Proxy can be reused for other tools (Touchstone, Postman, custom scripts)
4. No modifications needed to Databricks gateway or Inferno config
5. Clean separation of concerns

## Components Built

### 1. Reverse Proxy (`proxy/server.js`)
- **Language**: Node.js (no dependencies, uses only built-in modules)
- **Port**: 3333 (configurable via `PROXY_PORT` env var)
- **Auth Mechanism**:
  - Calls `databricks auth token -p FHIR` before each request
  - Caches token for 55 minutes
  - Refreshes if <5 min remaining
  - Falls back to cached token if refresh fails
- **Features**:
  - Transparent request forwarding
  - Automatic header injection
  - CORS support for browser clients
  - Health check endpoint (`/health`)
  - Logging of all requests

### 2. Infrastructure
- **docker-compose.yml**: Defines Inferno service on port 4567
- **test-proxy.sh**: Validation script (tests metadata, auth, CORS, operations)
- **.env.example**: Configuration template
- **INFERNO_SETUP.md**: User guide for running Inferno
- **README.md**: Quick start guide

### 3. Documentation
- **README.md**: Quick start + troubleshooting (9.9KB)
- **INFERNO_SETUP.md**: Detailed Inferno guide (8.4KB)
- **IMPLEMENTATION_NOTES.md**: This file (architecture decisions)

## Testing Performed

All proxy functionality tested and verified working:

```
✓ Proxy health check (HTTP 200)
✓ Metadata endpoint (returns CapabilityStatement 5.1.23-0bc44b2)
✓ Databricks authorization header injection (HTTP 200 vs 302 without)
✓ CORS headers (Access-Control-Allow-Origin: *)
✓ Common FHIR operations (Patient, Observation - return 401 as expected without creds)
✓ Proxy can handle rapid requests (token caching working)
```

Run tests anytime:
```bash
cd tests/compliance
bash test-proxy.sh
```

## Known Limitations & Blockers

### 1. Medplum Credentials Not Yet Available
- **Status**: ⏳ Blocked (credentials to be provided separately)
- **Impact**: Data endpoints return 401 Unauthorized
- **Solution**: Once credentials available:
  ```bash
  export MEDPLUM_TOKEN=<token>
  node proxy/server.js
  ```
  Then modify `proxy/server.js` to inject the token in request headers

### 2. Docker Daemon Not Running
- **Status**: ⚠️ During testing (can be started)
- **Impact**: Cannot run `docker-compose` to start Inferno container
- **Solution**: Start Docker Desktop or Docker daemon before running compliance tests

### 3. Inferno SMART/OAuth Flow Not Supported
- **Status**: 🔄 Future enhancement
- **Impact**: Can't test SMART app authorization with proxy
- **Solution**: Would need to:
  - Configure Medplum OAuth client credentials
  - Set up SMART app redirect URIs
  - Implement OAuth token exchange in proxy (or run Inferno natively)

### 4. No Firewall Bypass for Touchstone
- **Status**: 🔄 Future work (not required for now)
- **Impact**: Can't use Touchstone (AEGIS) until server is internet-accessible
- **Solution**: Would require VPN/firewall changes or Databricks workspace routing

## How to Proceed: Full Compliance Test Workflow

When Medplum credentials are available:

### Step 1: Update Proxy Configuration

Edit `proxy/server.js` and modify the `proxyRequest()` function:

```javascript
// After line that adds Databricks token, add:
const medplumToken = getMedplumToken();
if (medplumToken) {
  // Determine correct header based on Medplum's expectation
  // Could be: 'X-Medplum-Auth', 'Authorization' (adds to Bearer), etc.
  targetReqHeaders['X-Medplum-Auth'] = medplumToken;
}
```

And update `getMedplumToken()`:

```javascript
function getMedplumToken() {
  return process.env.MEDPLUM_TOKEN || null;
}
```

### Step 2: Verify Proxy Still Works

```bash
# Restart proxy with Medplum creds
export MEDPLUM_TOKEN="<your-token>"
cd tests/compliance/proxy
node server.js

# In another terminal:
bash tests/compliance/test-proxy.sh
```

### Step 3: Run Inferno

```bash
# Terminal 1: Proxy (already running)

# Terminal 2: Start Inferno
docker-compose -f tests/compliance/docker-compose.yml up

# Terminal 3: Open browser
open http://localhost:4567
```

### Step 4: Configure and Run Tests

1. Select test suite: **US Core v7** (recommended for Medplum)
2. Enter endpoint: `http://localhost:3333/fhir/R4`
3. Auth config: Leave empty (proxy handles it)
4. Click "Run Tests"
5. Wait 2-5 minutes for test suite to complete
6. Review results and export

### Step 5: Address Failures

Expected results:
- **Metadata**: ✅ Pass (always)
- **Patient search/read**: ✅ Pass (data tests now work)
- **Observation search/read**: ✅ Pass
- **Create/Update**: Depends on Medplum permissions
- **Validation errors**: May indicate CapabilityStatement mismatch

For failures:
- Click individual tests to see request/response
- Compare against FHIR spec
- Check if Medplum declares support in CapabilityStatement
- May be OK to skip if optional (US Core MUST vs SHOULD)

### Step 6: Generate Compliance Report

1. Click "Export" in Inferno (usually top-right)
2. Choose format: HTML or JSON
3. Save to: `tests/compliance/results/[run-date].json` or `.html`
4. Use for compliance documentation/audit trail

## Proxy Extensibility

### Adding Other Auth Layers

If Medplum later needs different auth (e.g., SMART OAuth):

```javascript
// In proxy/server.js, proxyRequest() function:

// 1. Get Medplum OAuth token
const medplumOAuthToken = await getMedplumOAuthToken();

// 2. Set in header
targetReqHeaders['Authorization'] = `Bearer ${medplumOAuthToken}`;
// Or if you need two auth layers:
targetReqHeaders['X-Original-Auth'] = `Bearer ${databricksToken}`;
```

### Monitoring / Logging

Current logs go to stdout. For production:

```bash
# Pipe to file
node proxy/server.js >> proxy.log 2>&1 &

# Or use process manager
pm2 start proxy/server.js --name fhir-proxy

# Or use systemd service
sudo systemctl start fhir-proxy
```

### Performance Optimization

Current proxy is simple and synchronous. If performance becomes an issue:

1. **Connection pooling**: Create HTTP agent with keepAlive
   ```javascript
   const agent = new http.Agent({ keepAlive: true });
   // Pass to protocol.request(..., { agent })
   ```

2. **Request timeout**: Add timeout handling
   ```javascript
   targetReq.setTimeout(30000); // 30 second timeout
   ```

3. **Caching**: Cache read-only requests (metadata, read operations)
   ```javascript
   // Cache GET /metadata for 1 hour
   ```

## Files Summary

```
tests/compliance/
├── README.md                    # Main quick-start guide
├── INFERNO_SETUP.md            # Detailed Inferno user guide
├── IMPLEMENTATION_NOTES.md     # This file
├── .env.example                # Environment config template
├── docker-compose.yml          # Inferno container config
├── test-proxy.sh               # Proxy validation script
└── proxy/
    ├── server.js               # Reverse proxy (main component)
    └── package.json            # Node.js package info
```

## Running the Test Suite: Exact Commands

### Terminal 1: Start Proxy

```bash
cd /Users/douglas.moore/development/dbxplum/tests/compliance/proxy
node server.js
```

Expected: Listens on `http://localhost:3333`

### Terminal 2: Validate Proxy

```bash
cd /Users/douglas.moore/development/dbxplum/tests/compliance
bash test-proxy.sh
```

Expected: All checks pass ✓

### Terminal 3: Start Inferno

```bash
cd /Users/douglas.moore/development/dbxplum/tests/compliance
docker-compose up inferno
```

Expected: Inferno UI available at `http://localhost:4567`

### Terminal 4 (Browser): Run Tests

1. Open: `http://localhost:4567`
2. Select: **US Core v7**
3. FHIR Endpoint: `http://localhost:3333/fhir/R4`
4. Click: **Run Tests**
5. Wait: 2-5 minutes
6. Export: Results when done

## Blockers Requiring User Action

| Item | Status | Required For | Action Needed |
|------|--------|-------------|---|
| Medplum credentials | ⏳ Pending | Data access tests | Obtain from Medplum admin |
| Update proxy for Medplum | ⏳ Pending | Data access | Modify `proxy/server.js` once creds available |
| Docker daemon | ⚠️ Not running | Inferno container | Start Docker |
| SMART OAuth setup | 🔄 Future | Full auth testing | Configure Medplum OAuth client |
| Internet access for Touchstone | 🔄 Future | Alternative compliance test | Modify Databricks firewall |

## Questions & Support

- **Proxy issues**: Check logs in Terminal 1
- **Inferno UI not loading**: Verify Docker is running, check `docker-compose logs`
- **Tests timeout**: Proxy logs should show request timing
- **401 Unauthorized**: Expected without Medplum creds (normal during development)
- **Architecture questions**: See this file

---

**Last Updated**: 2026-09-21
**Status**: Ready for compliance testing (awaiting Medplum credentials)
**Proxy**: ✅ Running and validated
**Inferno**: ✅ Ready to launch
**Full tests**: 🔄 Blocked on credentials
