/**
 * Scenario C: Authenticated Read/Write
 *
 * REQUIRES: MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET environment variables
 *
 * Mix of:
 * - GET Patient/{id}
 * - GET Patient?... (search)
 * - POST Patient (create)
 *
 * Ramp 1→25 VUs, strict thresholds (p95<1s, error<1%)
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';

// Bearer token for Medplum (obtained via client_credentials flow)
let medplumToken = '';

// Marker so teardown() can find and delete exactly the Patients this run created
// (this write scenario creates a Patient every iteration; without cleanup those
// orphans accumulate on the live server across runs, unlike scenario-c-node.mjs).
const PERF_TAG_SYSTEM = 'https://dbxplum.test/perf-scenario-c';

export const options = {
  stages: [
    { duration: '30s', target: 1 },  // ramp up to 1 VU
    { duration: '2m', target: 25 },  // ramp up to 25 VUs
    { duration: '2m', target: 25 },  // stay at 25 VUs
    { duration: '30s', target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(50)<300', 'p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.01'],  // <1% error rate
    http_reqs: ['rate>20'],
  },
  setupTimeout: '30s',
};

/**
 * Setup: Obtain Medplum auth token via client_credentials
 */
export function setup() {
  const clientId = __ENV.MEDPLUM_CLIENT_ID;
  const clientSecret = __ENV.MEDPLUM_CLIENT_SECRET;
  const appUrl = __ENV.APP_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
  const dbToken = __ENV.DATABRICKS_TOKEN;

  if (!clientId || !clientSecret) {
    console.error('MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET must be set');
    return { token: null, appUrl, dbToken };
  }

  // Get Medplum OAuth token
  const authParams = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${dbToken}`,
    },
  };

  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;

  const res = http.post(`${appUrl}/oauth2/token`, body, authParams);

  if (res.status !== 200) {
    console.error(`Failed to get Medplum token: ${res.status} ${res.body}`);
    return { token: null, appUrl, dbToken };
  }

  const token = res.json('access_token');
  console.log('Successfully obtained Medplum token');
  // Unique per-run tag applied to every created Patient, used by teardown().
  const runTag = `run-${Date.now()}`;
  return { token, appUrl, dbToken, runTag };
}

export default function (data) {
  const appUrl = data.appUrl;
  const dbToken = data.dbToken;
  const medplumToken = data.token;

  if (!medplumToken) {
    console.error('Medplum token not available; skipping authenticated tests');
    return;
  }

  // Auth relay the app proxy expects: Databricks gateway reads Authorization,
  // strips it, and the medplum-server proxy reads the Medplum token from the
  // __medplum_token cookie (NOT an X-Medplum header). Matches scenario-c-node.mjs.
  const params = {
    headers: {
      'Authorization': `Bearer ${dbToken}`,
      'Cookie': `__medplum_token=${medplumToken}`,
      'Content-Type': 'application/fhir+json',
    },
  };

  // Scenario: Read existing patient
  group('GET Patient search', () => {
    const searchRes = http.get(`${appUrl}/fhir/R4/Patient?_count=10`, params);
    check(searchRes, {
      'search status is 200': (r) => r.status === 200,
      'search has bundle': (r) => r.json('resourceType') === 'Bundle',
      'response time < 1s': (r) => r.timings.duration < 1000,
    });
  });

  sleep(0.3);

  // Scenario: Create a patient (simplified; real payload would include demographics)
  group('POST Patient create', () => {
    const patientPayload = JSON.stringify({
      resourceType: 'Patient',
      meta: { tag: [{ system: PERF_TAG_SYSTEM, code: data.runTag }] },
      name: [
        {
          family: 'Test',
          given: ['Perf' + Math.random().toString(36).substr(2, 9)],
        },
      ],
      birthDate: '1990-01-01',
    });

    const createRes = http.post(`${appUrl}/fhir/R4/Patient`, patientPayload, params);
    check(createRes, {
      'create status is 201 or 200': (r) => r.status === 201 || r.status === 200,
      'create has resourceType': (r) => r.json('resourceType') === 'Patient',
      'response time < 1s': (r) => r.timings.duration < 1000,
    });
  });

  sleep(0.3);

  // Scenario: Read metadata (baseline, should be fast)
  group('GET metadata', () => {
    const metaRes = http.get(`${appUrl}/fhir/R4/metadata`, params);
    check(metaRes, {
      'metadata status is 200': (r) => r.status === 200,
    });
  });

  sleep(0.3);
}

/**
 * Teardown: delete every Patient this run created (matched by the run tag) so
 * the write scenario doesn't leave orphans on the live server.
 */
export function teardown(data) {
  if (!data.token) return;

  const params = {
    headers: {
      'Authorization': `Bearer ${data.dbToken}`,
      'Cookie': `__medplum_token=${data.token}`,
      'Content-Type': 'application/fhir+json',
    },
  };

  const searchUrl = `${data.appUrl}/fhir/R4/Patient?_tag=${encodeURIComponent(PERF_TAG_SYSTEM)}%7C${encodeURIComponent(data.runTag)}&_count=100`;

  // Delete-then-research: each successful delete removes the resource from the
  // next search. Stop as soon as a round makes no progress (every delete on the
  // current page failed) so one undeletable Patient can't spin all 500 rounds;
  // 404 counts as progress (already gone, tolerates eventually-consistent search).
  let deleted = 0;
  for (let round = 0; round < 500; round++) {
    const res = http.get(searchUrl, params);
    if (res.status !== 200) break;
    const entries = res.json('entry') || [];
    if (!entries.length) break;
    let progressed = 0;
    for (const entry of entries) {
      const id = entry.resource && entry.resource.id;
      if (!id) continue;
      const del = http.del(`${data.appUrl}/fhir/R4/Patient/${id}`, null, params);
      if ((del.status >= 200 && del.status < 300) || del.status === 404) {
        deleted++;
        progressed++;
      }
    }
    if (!progressed) break; // no resource removable this round — avoid spinning
  }
  console.log(`teardown: deleted ${deleted} Patient(s) tagged ${data.runTag}`);
}
