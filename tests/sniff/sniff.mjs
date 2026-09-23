#!/usr/bin/env node
/**
 * FHIR Sniff Test for Medplum on Databricks Apps
 *
 * Quick smoke test verifying:
 * 1. Gateway reachability + /healthcheck
 * 2. FHIR Capability Statement fetch
 * 3. Auth enforcement (401 without creds)
 * 4. CRUD round-trip (if Medplum creds provided)
 */

import https from 'https';
import http from 'http';

const BASE_URL = process.env.MEDPLUM_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN;
const MEDPLUM_CLIENT_ID = process.env.MEDPLUM_CLIENT_ID;
const MEDPLUM_CLIENT_SECRET = process.env.MEDPLUM_CLIENT_SECRET;

// Test results tracking
const results = [];

class TestResult {
  constructor(step) {
    this.step = step;
    this.status = 'PENDING';
    this.code = null;
    this.notes = '';
  }

  pass(code, notes = '') {
    this.status = 'PASS';
    this.code = code;
    this.notes = notes;
    return this;
  }

  fail(code, notes = '') {
    this.status = 'FAIL';
    this.code = code;
    this.notes = notes;
    return this;
  }

  skip(notes = '') {
    this.status = 'SKIP';
    this.notes = notes;
    return this;
  }
}

/**
 * Make an HTTP(S) request with optional Databricks token and Medplum token cookie
 */
async function request(method, path, body = null, medplumToken = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/fhir+json',
    };

    // Add Databricks token to pass the gateway
    if (DATABRICKS_TOKEN) {
      headers['Authorization'] = `Bearer ${DATABRICKS_TOKEN}`;
    }

    // Add Medplum token as cookie (the proxy looks for __medplum_token cookie)
    if (medplumToken) {
      headers['Cookie'] = `__medplum_token=${medplumToken}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          const json = body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, headers: res.headers, body: json, rawBody: body });
        } catch (err) {
          resolve({ status: res.statusCode, headers: res.headers, body: null, rawBody: body });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.abort();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Make a POST request with form-urlencoded body (for OAuth token endpoint)
 */
async function requestFormEncoded(method, path, formData) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const params = new URLSearchParams(formData);
    const body = params.toString();

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': body.length,
    };

    if (DATABRICKS_TOKEN) {
      headers['Authorization'] = `Bearer ${DATABRICKS_TOKEN}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          const json = bodyStr ? JSON.parse(bodyStr) : null;
          resolve({ status: res.statusCode, headers: res.headers, body: json, rawBody: bodyStr });
        } catch (err) {
          resolve({ status: res.statusCode, headers: res.headers, body: null, rawBody: bodyStr });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.abort();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Test 1: Healthcheck endpoint (validates gateway + backend)
 */
async function testHealthcheck() {
  const result = new TestResult('1. Healthcheck');
  try {
    const res = await request('GET', '/healthcheck');
    if (res.status === 200 && res.body && res.body.ok === true) {
      const notes = `postgres=${res.body.postgres}, redis=${res.body.redis}`;
      result.pass(res.status, notes);
    } else {
      result.fail(res.status, `Expected ok:true, got: ${JSON.stringify(res.body)}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 2: FHIR Capability Statement (public endpoint)
 */
async function testCapabilityStatement() {
  const result = new TestResult('2. GET /fhir/R4/metadata');
  try {
    const res = await request('GET', '/fhir/R4/metadata');
    if (res.status === 200 && res.body && res.body.resourceType === 'CapabilityStatement') {
      const fhirVersion = res.body.fhirVersion || 'unknown';
      const softwareVersion = res.body.software?.version || 'unknown';
      const notes = `fhirVersion=${fhirVersion}, software=${softwareVersion}`;
      result.pass(res.status, notes);
    } else {
      result.fail(res.status, `Expected CapabilityStatement, got resourceType=${res.body?.resourceType}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 3: Auth enforcement - GET /fhir/R4/Patient without Medplum token should be 401
 */
async function testAuthEnforcement() {
  const result = new TestResult('3. Auth Enforcement (GET /fhir/R4/Patient without token)');
  try {
    const res = await request('GET', '/fhir/R4/Patient');
    if (res.status === 401) {
      result.pass(res.status, 'Correctly rejected unauthenticated request');
    } else if (res.status === 200) {
      result.fail(res.status, 'Expected 401, but got 200 (auth may not be enforced!)');
    } else {
      result.fail(res.status, `Expected 401, got ${res.status}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 4: Obtain Medplum access token via OAuth2 client_credentials
 */
async function getMedplumToken() {
  try {
    const res = await requestFormEncoded('POST', '/oauth2/token', {
      grant_type: 'client_credentials',
      client_id: MEDPLUM_CLIENT_ID,
      client_secret: MEDPLUM_CLIENT_SECRET,
    });

    if (res.status === 200 && res.body && res.body.access_token) {
      return res.body.access_token;
    } else {
      console.error(`OAuth2 token request failed: ${res.status}`, res.body);
      return null;
    }
  } catch (err) {
    console.error('OAuth2 token request error:', err.message);
    return null;
  }
}

/**
 * Test 5: CRUD round-trip - Create Patient
 */
async function testCreatePatient(medplumToken) {
  const result = new TestResult('4. CRUD: Create Patient (POST)');
  try {
    const patientPayload = {
      resourceType: 'Patient',
      name: [{
        given: ['Test'],
        family: 'Sniff',
      }],
      telecom: [{
        system: 'email',
        value: 'sniff@test.local',
      }],
    };

    const res = await request('POST', '/fhir/R4/Patient', patientPayload, medplumToken);
    if (res.status === 201 && res.body && res.body.id) {
      result.pass(res.status, `Created patient id=${res.body.id}`);
      return res.body.id;
    } else if (res.status === 200 && res.body && res.body.id) {
      result.pass(res.status, `Created patient id=${res.body.id}`);
      return res.body.id;
    } else {
      result.fail(res.status, `Expected 200/201, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
      return null;
    }
  } catch (err) {
    result.fail(null, err.message);
    return null;
  } finally {
    results.push(result);
  }
}

/**
 * Test 6: CRUD round-trip - Read Patient by ID
 */
async function testReadPatient(medplumToken, patientId) {
  const result = new TestResult('5. CRUD: Read Patient by ID (GET)');
  try {
    const res = await request('GET', `/fhir/R4/Patient/${patientId}`, null, medplumToken);
    if (res.status === 200 && res.body && res.body.id === patientId) {
      result.pass(res.status, `Read patient name=${res.body.name?.[0]?.family || 'unknown'}`);
    } else {
      result.fail(res.status, `Expected 200, got ${res.status}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 7: CRUD round-trip - Update Patient
 */
async function testUpdatePatient(medplumToken, patientId) {
  const result = new TestResult('6. CRUD: Update Patient (PUT)');
  try {
    const updatePayload = {
      resourceType: 'Patient',
      id: patientId,
      name: [{
        given: ['Test', 'Updated'],
        family: 'Sniff',
      }],
      telecom: [{
        system: 'email',
        value: 'sniff@test.local',
      }],
    };

    const res = await request('PUT', `/fhir/R4/Patient/${patientId}`, updatePayload, medplumToken);
    if ((res.status === 200 || res.status === 204) && res.body) {
      result.pass(res.status, `Updated patient`);
    } else {
      result.fail(res.status, `Expected 200/204, got ${res.status}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 8: CRUD round-trip - Search Patient
 */
async function testSearchPatient(medplumToken) {
  const result = new TestResult('7. CRUD: Search Patient (GET ?family=)');
  try {
    const res = await request('GET', '/fhir/R4/Patient?family=Sniff', null, medplumToken);
    if (res.status === 200 && res.body && res.body.resourceType === 'Bundle') {
      const count = res.body.entry?.length || 0;
      result.pass(res.status, `Search returned ${count} patient(s)`);
    } else {
      result.fail(res.status, `Expected 200 Bundle, got ${res.status}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 9: CRUD round-trip - Version history
 */
async function testVersionHistory(medplumToken, patientId) {
  const result = new TestResult('8. CRUD: Version History (GET .../_history)');
  try {
    const res = await request('GET', `/fhir/R4/Patient/${patientId}/_history`, null, medplumToken);
    if (res.status === 200 && res.body && res.body.resourceType === 'Bundle') {
      const count = res.body.entry?.length || 0;
      result.pass(res.status, `History returned ${count} version(s)`);
    } else {
      result.fail(res.status, `Expected 200 Bundle, got ${res.status}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Test 10: CRUD round-trip - Delete Patient
 */
async function testDeletePatient(medplumToken, patientId) {
  const result = new TestResult('9. CRUD: Delete Patient (DELETE)');
  try {
    const res = await request('DELETE', `/fhir/R4/Patient/${patientId}`, null, medplumToken);
    if (res.status === 200 || res.status === 204 || res.status === 202) {
      result.pass(res.status, `Deleted patient`);
    } else {
      result.fail(res.status, `Expected 200/204/202, got ${res.status}`);
    }
  } catch (err) {
    result.fail(null, err.message);
  }
  results.push(result);
}

/**
 * Print summary table
 */
function printSummary() {
  console.log('\n' + '='.repeat(100));
  console.log('FHIR SNIFF TEST SUMMARY');
  console.log('='.repeat(100));
  console.log(`URL: ${BASE_URL}`);
  console.log(`Databricks Token: ${DATABRICKS_TOKEN ? '✓ Present' : '✗ Missing'}`);
  console.log(`Medplum Creds: ${MEDPLUM_CLIENT_ID ? '✓ Present' : '✗ Missing'}`);
  console.log('='.repeat(100));
  console.log(`${'Step'.padEnd(45)} ${'Status'.padEnd(10)} ${'Code'.padEnd(8)} Notes`);
  console.log('-'.repeat(100));

  let allPassed = true;
  for (const result of results) {
    const status = result.status.padEnd(10);
    const code = (result.code ? String(result.code) : '-').padEnd(8);
    const step = result.step.padEnd(45);
    const notes = result.notes.substring(0, 37);

    console.log(`${step} ${status} ${code} ${notes}`);

    // Track failures (skip skipped tests)
    if (result.status === 'FAIL') {
      allPassed = false;
    }
  }

  console.log('='.repeat(100));
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const passCount = results.filter(r => r.status === 'PASS').length;
  const skipCount = results.filter(r => r.status === 'SKIP').length;

  console.log(`TOTAL: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);

  if (allPassed) {
    console.log('RESULT: ✓ ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.log('RESULT: ✗ SOME TESTS FAILED');
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  if (!DATABRICKS_TOKEN) {
    console.error('ERROR: DATABRICKS_TOKEN not set. Get it with:');
    console.error('  export DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token)');
    process.exit(1);
  }

  console.log('Starting FHIR Sniff Test...\n');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Databricks Token: ${DATABRICKS_TOKEN.substring(0, 20)}...`);
  console.log(`Medplum Creds: ${MEDPLUM_CLIENT_ID ? 'Present' : 'Missing'}`);
  console.log('\n');

  // Test 1-3: Always run (public + auth enforcement)
  await testHealthcheck();
  await testCapabilityStatement();
  await testAuthEnforcement();

  // Test 4-10: Only run if Medplum creds are provided
  if (MEDPLUM_CLIENT_ID && MEDPLUM_CLIENT_SECRET) {
    console.log('Medplum credentials found, running authenticated CRUD tests...\n');

    const medplumToken = await getMedplumToken();
    if (!medplumToken) {
      const result = new TestResult('4. OAuth2 Token Acquisition');
      result.fail(null, 'Failed to obtain Medplum access token');
      results.push(result);
    } else {
      const result = new TestResult('4. OAuth2 Token Acquisition');
      result.pass(200, `Token obtained (${medplumToken.substring(0, 20)}...)`);
      results.push(result);

      const patientId = await testCreatePatient(medplumToken);
      if (patientId) {
        await testReadPatient(medplumToken, patientId);
        await testUpdatePatient(medplumToken, patientId);
        await testSearchPatient(medplumToken);
        await testVersionHistory(medplumToken, patientId);
        await testDeletePatient(medplumToken, patientId);
      }
    }
  } else {
    const result = new TestResult('4. OAuth2 Token Acquisition');
    result.skip('MEDPLUM_CLIENT_ID/MEDPLUM_CLIENT_SECRET not set');
    results.push(result);

    for (let i = 5; i <= 9; i++) {
      const r = new TestResult(`${i}. CRUD (skipped)`);
      r.skip('Medplum credentials not available');
      results.push(r);
    }
  }

  printSummary();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
