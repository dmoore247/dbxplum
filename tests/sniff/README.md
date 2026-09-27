# FHIR Sniff Test for Medplum on Databricks Apps

A fast smoke test suite for verifying the Medplum FHIR R4 server deployment on Databricks Apps.

## What It Tests

### Phase 1: Always-Run Tests (No Auth Required)
1. **Healthcheck** (`GET /healthcheck`) — Verifies gateway reachability and backend services (postgres, redis)
2. **FHIR Capability Statement** (`GET /fhir/R4/metadata`) — Fetches capability metadata, prints FHIR version & software version
3. **Auth Enforcement** (`GET /fhir/R4/Patient` without token) — Confirms server returns 401 (auth is enforced)

### Phase 2: Authenticated CRUD Tests (Requires Medplum Credentials)
4. **OAuth2 Token Acquisition** (`POST /oauth2/token`) — Obtains Medplum access token via client_credentials grant
5. **Create Patient** (`POST /fhir/R4/Patient`) — Creates a test patient resource
6. **Read Patient** (`GET /fhir/R4/Patient/{id}`) — Fetches the created patient
7. **Update Patient** (`PUT /fhir/R4/Patient/{id}`) — Updates the patient record
8. **Search Patient** (`GET /fhir/R4/Patient?family=Sniff`) — Searches for the test patient
9. **Version History** (`GET /fhir/R4/Patient/{id}/_history`) — Retrieves the patient's version history
10. **Delete Patient** (`DELETE /fhir/R4/Patient/{id}`) — Deletes the test patient

## Prerequisites

### Required
- **Databricks token**: Needed to pass the Databricks gateway layer. Obtain via:
  ```bash
  export DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)
  ```

### Optional (for Phase 2)
- **MEDPLUM_CLIENT_ID** and **MEDPLUM_CLIENT_SECRET**: Required to run authenticated CRUD tests.
  - These are created by registering a ClientApplication in Medplum after initial user setup.
  - If not provided, Phase 2 tests are gracefully skipped.

## Usage

### Quick Test (Phase 1 Only)
```bash
export DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)

# Node version
node tests/sniff/sniff.mjs

# Or Bash version
bash tests/sniff/sniff.sh
```

### Full Test (With Medplum Credentials)
```bash
export DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)
export MEDPLUM_CLIENT_ID=<your-client-id>
export MEDPLUM_CLIENT_SECRET=<your-client-secret>

# Node version
node tests/sniff/sniff.mjs

# Or Bash version
bash tests/sniff/sniff.sh
```

### Custom Base URL
```bash
export MEDPLUM_URL=https://your-custom-url.aws.databricksapps.com
node tests/sniff/sniff.mjs
```

## Output

The script produces a summary table with:
- **Step**: Test name
- **Status**: PASS / FAIL / SKIP
- **Code**: HTTP status code (or "-" for skipped/errored tests)
- **Notes**: Details (e.g., resource IDs, error messages, counts)

Example output:
```
=====================================================================================================
FHIR SNIFF TEST SUMMARY
=====================================================================================================
URL: https://medplum-server-3464092709171785.aws.databricksapps.com
Databricks Token: ✓ Present
Medplum Creds: ✗ Missing
=====================================================================================================
Step                                          Status     Code     Notes
-----------------------------------------------------------------------------------------------------
1. Healthcheck                                PASS       200      postgres=true, redis=true
2. GET /fhir/R4/metadata                      PASS       200      fhirVersion=4.0.1, software=5.1.23-0b
3. Auth Enforcement                           PASS       401      Correctly rejected unauthenticated re
4. OAuth2 Token Acquisition                   SKIP       -        MEDPLUM_CLIENT_ID/SECRET not set
5. CRUD Create Patient                        SKIP       -        Medplum credentials not available
...
=====================================================================================================
TOTAL: 3 passed, 0 failed, 4 skipped
RESULT: ✓ ALL TESTS PASSED
```

## Exit Codes

- **0**: All non-skipped tests passed
- **1**: One or more tests failed

## Authentication Flow

The test suite handles two layers of authentication:

### Layer 1: Databricks Gateway
- Every HTTP request includes: `Authorization: Bearer <DATABRICKS_TOKEN>`
- This token is obtained from your Databricks workspace and lets requests through the gateway.

### Layer 2: Medplum Application Auth
- **Public endpoints** (`/healthcheck`, `/fhir/R4/metadata`) work with just the Databricks token.
- **Protected endpoints** (`/fhir/R4/Patient`, etc.) require a Medplum token.
- The Medplum token is obtained via OAuth2 client_credentials flow at `POST /oauth2/token`.
- The token is passed via an HttpOnly cookie `__medplum_token` (the app's proxy injects it into the Authorization header).

See `/apps/medplum-server/start.js` (lines 306-325) for the proxy logic.

## Implementation Notes

### Node Version (sniff.mjs)
- Uses Node's built-in `https` and `http` modules.
- Handles JSON parsing, FHIR resource creation, and cookie management.
- Idempotent: safe to re-run multiple times.

### Bash Version (sniff.sh)
- Uses `curl` for HTTP requests and `jq` for JSON parsing.
- Simpler to integrate into existing shell scripts/CI pipelines.
- POSIX-compatible (uses `sed` instead of non-portable `head -n -1`).
- Idempotent: safe to re-run multiple times.

## Idempotency

Both scripts are **idempotent**:
- Creates a new test patient each run (does not reuse old ones).
- No persistent state modifications outside the test.
- Safe to run repeatedly in CI/CD pipelines.

## Troubleshooting

### 401 Unauthorized on Healthcheck
- Check `DATABRICKS_TOKEN` is valid and not expired (tokens expire in 1 hour).
- Refresh token: `export DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)`

### 502 Bad Gateway
- Medplum server may not be running or not ready.
- Check server logs in the Databricks App.

### OAuth2 Token Request Returns 400
- `MEDPLUM_CLIENT_ID` or `MEDPLUM_CLIENT_SECRET` is incorrect.
- Verify credentials are created in Medplum admin panel.

### Patient CRUD Tests FAIL
- Ensure `MEDPLUM_CLIENT_ID` and `MEDPLUM_CLIENT_SECRET` are valid.
- Check server logs for detailed error messages in OperationOutcome responses.

## Future Enhancements

- [ ] Parameterized resource types (test beyond Patient)
- [ ] Bulk operation tests
- [ ] Subscription tests
- [ ] Performance benchmarking
- [ ] CI/CD integration templates
