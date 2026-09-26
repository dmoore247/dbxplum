#!/usr/bin/env node

/**
 * Performance test runner using autocannon
 * Runs Scenarios A and B with latency/throughput metrics
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const APP_URL = process.env.APP_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

let token = '';

/**
 * Get fresh Databricks token
 */
async function getToken() {
  console.log('\n[*] Fetching Databricks token...');
  return new Promise((resolve, reject) => {
    const child = spawn('databricks', ['auth', 'token', '-p', 'FHIR'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to get token: ${stderr}`));
      } else {
        try {
          const parsed = JSON.parse(stdout);
          const tok = parsed.access_token;
          console.log(`[✓] Token obtained (exp: ${parsed.expiry})`);
          resolve(tok);
        } catch (e) {
          reject(new Error(`Failed to parse token: ${e.message}`));
        }
      }
    });
  });
}

/**
 * Verify app is reachable
 */
async function verifyEndpoints() {
  console.log('[*] Verifying endpoints...');

  const url = new URL(`${APP_URL}/healthcheck`);
  const requestUrl = url.href;

  return new Promise((resolve, reject) => {
    const req = https.get(
      requestUrl,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok === true) {
              console.log('[✓] Endpoints reachable, Redis and Postgres OK');
              resolve();
            } else {
              reject(new Error('Healthcheck not ok'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse healthcheck: ${e.message}`));
          }
        });
      }
    );

    req.on('error', (e) => {
      reject(e);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Endpoint verification timeout'));
    });
  });
}

/**
 * Run a scenario with curl in a loop (lightweight alternative to k6)
 */
async function runScenario(scenario, config) {
  const {
    displayName,
    endpoint,
    duration,
    vus,
    rampProfile = null, // for ramp tests, array of {duration, target}
  } = config;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[*] Running Scenario ${scenario}: ${displayName}`);
  console.log(`${'='.repeat(60)}`);

  const resultsFile = path.join(RESULTS_DIR, `scenario-${scenario}-results.txt`);
  const metricsFile = path.join(RESULTS_DIR, `scenario-${scenario}-metrics.json`);

  const startTime = Date.now();
  let totalRequests = 0;
  let totalErrors = 0;
  const latencies = [];

  /**
   * Simple curl-based load generator
   */
  const generateLoad = (numVUs, runDurationMs) => {
    return new Promise((resolve) => {
      let completedVUs = 0;
      const vuStartTimes = [];

      for (let i = 0; i < numVUs; i++) {
        vuStartTimes.push(Date.now());
      }

      const vuPromises = [];

      for (let i = 0; i < numVUs; i++) {
        const vuPromise = new Promise((vuResolve) => {
          const runVU = () => {
            const reqStart = Date.now();
            const elapsed = reqStart - vuStartTimes[i];

            if (elapsed > runDurationMs) {
              completedVUs++;
              if (completedVUs === numVUs) {
                resolve();
              }
              vuResolve();
              return;
            }

            // A request settles exactly once (end | error | timeout). Guard so a
            // timeout that destroys the socket and a following 'error' event
            // can't both count the request and re-schedule this VU (which would
            // fork the VU chain and inflate concurrency / totals).
            let settled = false;
            const finish = (isError, latency) => {
              if (settled) return;
              settled = true;
              totalRequests++;
              if (isError) totalErrors++;
              if (latency != null) latencies.push(latency);
              setTimeout(runVU, 100); // small think time
            };

            // Make request
            const url = new URL(`${APP_URL}${endpoint}`);
            const client = url.protocol === 'https:' ? https : http;

            const req = client.get(
              url,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/fhir+json',
                },
              },
              (res) => {
                // Only status/latency matter — drain and discard the body
                // instead of buffering it (large FHIR bundles would waste memory).
                res.resume();
                res.on('end', () => finish(res.statusCode < 200 || res.statusCode >= 300, Date.now() - reqStart));
              }
            );

            req.on('error', () => finish(true, null));

            req.setTimeout(5000, () => {
              req.destroy();
              finish(true, null);
            });
          };

          runVU();
        });

        vuPromises.push(vuPromise);
      }

      Promise.all(vuPromises).then(() => {
        resolve();
      });
    });
  };

  // Execute test
  if (rampProfile) {
    // Ramp profile (for Scenario B)
    console.log(`Ramp profile:`);
    rampProfile.forEach((stage, idx) => {
      console.log(`  Stage ${idx + 1}: ${stage.duration}s → ${stage.target} VUs`);
    });

    let elapsed = 0;
    for (const stage of rampProfile) {
      const stageDurationMs = stage.duration * 1000;
      const targetVUs = stage.target;

      console.log(`\n[*] Stage: ${stage.duration}s @ ${targetVUs} VUs (${stage.duration * 1000}ms)...`);

      if (targetVUs > 0) {
        await generateLoad(targetVUs, stageDurationMs);
      } else {
        // Ramp-down to 0 VUs: honor the stage duration instead of resolving
        // instantly (generateLoad(0) -> Promise.all([]) resolves in ~0ms),
        // which would shorten totalTime and inflate reported throughput.
        await new Promise((r) => setTimeout(r, stageDurationMs));
      }

      elapsed += stage.duration;
      console.log(`[✓] Stage complete. Elapsed: ${elapsed}s, Total reqs: ${totalRequests}`);
    }
  } else {
    // Fixed VU profile (for Scenario A)
    console.log(`Profile: ${vus} VU(s) for ${duration}s`);
    await generateLoad(vus, duration * 1000);
  }

  const totalTime = Date.now() - startTime;

  // Calculate statistics
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length || 0;
  // latencies is already sorted ascending; index directly instead of spreading
  // into Math.min/max, which throws RangeError on very large (100k+) arrays.
  const min = latencies.length ? latencies[0] : 0;
  const max = latencies.length ? latencies[latencies.length - 1] : 0;

  // Guard against a stage where no request completed (unreachable endpoint or a
  // 0-VU ramp-down): 0/0 would serialize as NaN/Infinity into the metrics file.
  const throughput = totalTime > 0 ? totalRequests / (totalTime / 1000) : 0;
  const errorRate = (totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0).toFixed(2);

  // Write results
  const summary = `Scenario ${scenario}: ${displayName}
=====================================
Total Requests:      ${totalRequests}
Total Errors:        ${totalErrors}
Error Rate:          ${errorRate}%
Throughput:          ${throughput.toFixed(2)} req/s
Total Time:          ${(totalTime / 1000).toFixed(2)}s

Latency (ms):
  Min:               ${min.toFixed(2)}
  Avg:               ${avg.toFixed(2)}
  p50:               ${p50}
  p95:               ${p95}
  p99:               ${p99}
  Max:               ${max}
`;

  console.log(`\n${summary}`);

  fs.writeFileSync(resultsFile, summary);
  fs.writeFileSync(
    metricsFile,
    JSON.stringify(
      {
        scenario,
        displayName,
        endpoint,
        timestamp: new Date().toISOString(),
        totalRequests,
        totalErrors,
        errorRate: parseFloat(errorRate),
        throughput,
        totalTime: totalTime / 1000,
        latency: {
          min,
          avg: parseFloat(avg.toFixed(2)),
          p50,
          p95,
          p99,
          max,
        },
      },
      null,
      2
    )
  );

  console.log(`[✓] Results saved to ${resultsFile}`);
  console.log(`[✓] Metrics saved to ${metricsFile}`);

  return { totalRequests, errorRate: parseFloat(errorRate), throughput, latency: { p50, p95, p99, avg } };
}

/**
 * Capture app logs
 */
async function captureLogs(label) {
  return new Promise((resolve) => {
    console.log(`\n[*] Capturing app logs (${label})...`);

    const child = spawn('databricks', ['apps', 'logs', 'medplum-server', '-p', 'FHIR', '--tail-lines', label === 'baseline' ? '20' : '50'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', () => {
      const logFile = path.join(RESULTS_DIR, `logs-${label}.txt`);
      fs.writeFileSync(logFile, stdout);
      console.log(`[✓] Logs saved to ${logFile}`);
      resolve();
    });

    child.on('error', (e) => {
      console.warn(`[!] Failed to capture logs: ${e.message}`);
      resolve();
    });
  });
}

/**
 * Main
 */
async function main() {
  try {
    // Get token
    token = await getToken();

    // Verify endpoints
    await verifyEndpoints();

    // Baseline logs
    await captureLogs('baseline');

    // Scenario A: Smoke test
    const scenarioAConfig = {
      displayName: 'Smoke Test (1 VU, 30s)',
      endpoint: '/fhir/R4/metadata',
      vus: 1,
      duration: 30,
    };

    const resultA = await runScenario('A', scenarioAConfig);

    // Small gap between scenarios
    await new Promise((r) => setTimeout(r, 5000));

    // Scenario B: Read baseline with ramp
    const scenarioBConfig = {
      displayName: 'Read Baseline (1→20 VUs ramp)',
      endpoint: '/fhir/R4/metadata',
      rampProfile: [
        { duration: 30, target: 1 },
        { duration: 90, target: 20 },
        { duration: 30, target: 20 },
        { duration: 30, target: 0 },
      ],
    };

    const resultB = await runScenario('B', scenarioBConfig);

    // Post-test logs
    await captureLogs('post-test');

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('[✓] All scenarios complete!');
    console.log(`${'='.repeat(60)}`);
    console.log(`Results: ${RESULTS_DIR}`);
    console.log('');
    console.log('Scenario A (Smoke):');
    console.log(`  Throughput: ${resultA.throughput.toFixed(2)} req/s`);
    console.log(`  Error Rate: ${resultA.errorRate}%`);
    console.log(`  p95 Latency: ${resultA.latency.p95}ms`);
    console.log(`  p99 Latency: ${resultA.latency.p99}ms`);
    console.log('');
    console.log('Scenario B (Read Baseline):');
    console.log(`  Throughput: ${resultB.throughput.toFixed(2)} req/s`);
    console.log(`  Error Rate: ${resultB.errorRate}%`);
    console.log(`  p95 Latency: ${resultB.latency.p95}ms`);
    console.log(`  p99 Latency: ${resultB.latency.p99}ms`);
    console.log('');
  } catch (error) {
    console.error(`[✗] Error: ${error.message}`);
    process.exit(1);
  }
}

main();
