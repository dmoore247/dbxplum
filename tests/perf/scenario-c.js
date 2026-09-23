/**
 * Scenario C: Authenticated Read/Write
 *
 * REQUIRES: MEDPLUM_CLIENT_ID and MEDPLUM_SECRET environment variables
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
  const clientSecret = __ENV.MEDPLUM_SECRET;
  const appUrl = __ENV.APP_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
  const dbToken = __ENV.DATABRICKS_TOKEN;

  if (!clientId || !clientSecret) {
    console.error('MEDPLUM_CLIENT_ID and MEDPLUM_SECRET must be set');
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
  return { token, appUrl, dbToken };
}

export default function (data) {
  const appUrl = data.appUrl;
  const dbToken = data.dbToken;
  const medplumToken = data.token;

  if (!medplumToken) {
    console.error('Medplum token not available; skipping authenticated tests');
    return;
  }

  const params = {
    headers: {
      'Authorization': `Bearer ${dbToken}`,
      'X-Medplum': `Bearer ${medplumToken}`,
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
