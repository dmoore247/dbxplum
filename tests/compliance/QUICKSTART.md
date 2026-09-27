# FHIR Compliance Testing - Quick Start

## TL;DR - Run in 3 Steps

### Step 1: Start the Proxy
```bash
cd tests/compliance/proxy
node server.js
```
Keep this running in a terminal.

### Step 2: Start Inferno
In a new terminal:
```bash
cd tests/compliance
docker-compose up inferno
```

### Step 3: Open Inferno
Open browser: **http://localhost:4567**

Configure:
- Test Suite: **US Core v7** (or FHIR R4 Core)
- FHIR Endpoint: **http://localhost:3333/fhir/R4**
- Auth: Leave empty
- Click **Run Tests**

Done! Watch the tests run and see results in real-time.

---

## What's Happening

```
Inferno (http://localhost:4567)
    ↓ FHIR requests
Proxy (http://localhost:3333) — adds Databricks token
    ↓ HTTPS with Authorization header
Medplum Server (AWS Databricks Apps)
    ↓ Returns responses
Proxy — removes sensitive headers
    ↓
Inferno — validates against FHIR spec
    ↓
You see: ✅ pass / ❌ fail results
```

## Current Status

| Component | Status |
|-----------|--------|
| Proxy | ✅ Working |
| Metadata endpoint | ✅ Working |
| Databricks auth | ✅ Working |
| Token refresh | ✅ Working |
| Inferno ready | ✅ Ready to launch |
| Full data testing | ⏳ Awaiting Medplum credentials |

## What Works Now

✅ Metadata endpoint (public, no auth needed)
✅ FHIR R4 compliance check
✅ Proxy connectivity test

```bash
# Verify it's working:
bash tests/compliance/test-proxy.sh
```

## What Needs Medplum Credentials

❌ Patient search/read
❌ Observation search/read
❌ Resource create/update
❌ Full US Core compliance

(401 errors are expected until credentials available)

## Common Issues

| Problem | Solution |
|---------|----------|
| "Connection refused" | Make sure proxy is running in terminal 1 |
| "Port already in use" | `lsof -ti:3333 \| xargs kill -9` |
| Docker not running | Start Docker Desktop or daemon |
| Inferno times out | Check proxy logs: `tail -f tests/compliance/proxy.log` |
| 401 on all tests | Normal without Medplum creds; metadata should work |

## Next Steps When Credentials Arrive

1. Update proxy with Medplum token:
   ```bash
   export MEDPLUM_TOKEN="<token>"
   cd tests/compliance/proxy && node server.js
   ```

2. Re-run full compliance suite in Inferno

3. Export results as JSON/HTML

4. Use for compliance documentation/audit

## Files

| File | Purpose |
|------|---------|
| `README.md` | Full guide with troubleshooting |
| `INFERNO_SETUP.md` | Detailed Inferno instructions |
| `IMPLEMENTATION_NOTES.md` | Architecture decisions |
| `VALIDATION_REPORT.md` | Test results & validation |
| `test-proxy.sh` | Automated validation |
| `proxy/server.js` | The reverse proxy |
| `docker-compose.yml` | Inferno container config |

## Help

- **Proxy not starting?** → Check `proxy/server.js` output
- **Inferno won't connect?** → Verify proxy with `curl http://localhost:3333/health`
- **Tests timing out?** → Proxy may be slow; check logs
- **Questions?** → See `README.md` Troubleshooting section

---

**Status**: Ready to run ✅

**Questions?** See full documentation in this directory.
