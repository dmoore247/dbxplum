/**
 * Scenario B: Read Baseline
 * Ramp 1→20 VUs over 2 minutes
 * GET /fhir/R4/metadata and /healthcheck
 * Capture throughput, p50/p95/p99 latency, error rate
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 1 },  // ramp up to 1 VU
    { duration: '90s', target: 20 }, // ramp up to 20 VUs over 90s
    { duration: '30s', target: 20 }, // stay at 20 VUs for 30s
    { duration: '30s', target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(50)<500', 'p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.01'],
    http_reqs: ['rate>10'],
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

  // Test metadata endpoint
  const metadataRes = http.get(`${appUrl}/fhir/R4/metadata`, params);
  check(metadataRes, {
    'metadata status is 200': (r) => r.status === 200,
    'metadata has CapabilityStatement': (r) => r.json('resourceType') === 'CapabilityStatement',
  });

  sleep(0.2);

  // Test healthcheck endpoint
  const healthParams = {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  };
  const healthRes = http.get(`${appUrl}/healthcheck`, healthParams);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
    'health ok is true': (r) => r.json('ok') === true,
  });

  sleep(0.3);
}
