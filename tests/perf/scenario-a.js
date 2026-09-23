/**
 * Scenario A: Smoke Test
 * 1 VU, 30s, GET /fhir/R4/metadata
 * Sanity check + warm baseline
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<3000'],
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  const token = __ENV.DATABRICKS_TOKEN;
  const appUrl = __ENV.APP_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';

  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/fhir+json',
    },
  };

  const res = http.get(`${appUrl}/fhir/R4/metadata`, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has resourceType': (r) => r.json('resourceType') === 'CapabilityStatement',
    'response time < 1s': (r) => r.timings.duration < 1000,
  });

  // Small think time
  sleep(0.5);
}
