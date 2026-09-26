#!/usr/bin/env node
/**
 * Scenario C (Node harness): Authenticated read/write load.
 *
 * Uses the SAME auth relay as the app proxy expects:
 *   - Databricks gateway: Authorization: Bearer <DATABRICKS_TOKEN>
 *   - Medplum token: __medplum_token cookie  (NOT an X-Medplum header)
 *
 * Mix per iteration: GET Patient search, POST Patient create, GET metadata.
 * Ramps concurrency, reports p50/p95/p99 latency, throughput, error rate.
 *
 * Env: DATABRICKS_TOKEN, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET, [APP_URL]
 *
 * Good-citizen caps: max 15 concurrent, ~90s total. Created Patients are
 * tracked and deleted in teardown.
 */
import { request, Agent } from 'node:https';
import { URL } from 'node:url';

// Keep-alive agent with bounded sockets so ramping concurrency reuses
// connections instead of exhausting local ephemeral ports (which shows up as
// spurious client-side connection resets, not server errors).
const agent = new Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32 });

const APP_URL = process.env.APP_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
const DB_TOKEN = process.env.DATABRICKS_TOKEN;
const CLIENT_ID = process.env.MEDPLUM_CLIENT_ID;
const CLIENT_SECRET = process.env.MEDPLUM_CLIENT_SECRET;

if (!DB_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing env: DATABRICKS_TOKEN, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET');
  process.exit(1);
}

function httpReq(method, path, { body, medplumToken, contentType } = {}) {
  return new Promise((resolve) => {
    const u = new URL(path, APP_URL);
    const headers = { Authorization: `Bearer ${DB_TOKEN}` };
    if (medplumToken) headers['Cookie'] = `__medplum_token=${medplumToken}`;
    if (body) { headers['Content-Type'] = contentType || 'application/fhir+json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const start = process.hrtime.bigint();
    const req = request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 15000, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({ status: res.statusCode, ms, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - start) / 1e6, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: 15000, body: '' }); });
    if (body) req.write(body);
    req.end();
  });
}

async function getMedplumToken() {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;
  const res = await httpReq('POST', '/oauth2/token', { body, contentType: 'application/x-www-form-urlencoded' });
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}

const created = [];
const samples = [];   // {op, status, ms}

async function oneIteration(mtok) {
  // 1) search
  let r = await httpReq('GET', '/fhir/R4/Patient?_count=10', { medplumToken: mtok });
  samples.push({ op: 'search', status: r.status, ms: r.ms });
  // 2) create
  const payload = JSON.stringify({ resourceType: 'Patient', name: [{ family: 'PerfC', given: ['n' + Math.random().toString(36).slice(2, 8)] }], birthDate: '1990-01-01' });
  r = await httpReq('POST', '/fhir/R4/Patient', { body: payload, medplumToken: mtok });
  samples.push({ op: 'create', status: r.status, ms: r.ms });
  if (r.status === 201 || r.status === 200) { try { created.push(JSON.parse(r.body).id); } catch {} }
  // 3) metadata
  r = await httpReq('GET', '/fhir/R4/metadata', { medplumToken: mtok });
  samples.push({ op: 'metadata', status: r.status, ms: r.ms });
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Medplum enforces a per-user FHIR-interaction rate limit (default ~50k
// points/min; a search/create costs multiple points). Pace each worker so the
// aggregate stays under quota — otherwise the server correctly returns 429 and
// the run measures throttling rather than capacity. THROTTLE_MS between
// iterations per worker.
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 250);

async function worker(mtok, deadline) {
  while (Date.now() < deadline) {
    await oneIteration(mtok);
    if (THROTTLE_MS) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }
}

async function run() {
  console.log(`Scenario C (authenticated) → ${APP_URL}`);
  const mtok = await getMedplumToken();
  console.log('Medplum token obtained. Ramping load (cap 15 VUs, ~90s)...\n');

  // Ramp: 3 phases of increasing concurrency
  const phases = [{ vus: 3, secs: 20 }, { vus: 8, secs: 30 }, { vus: 15, secs: 40 }];
  const t0 = Date.now();
  for (const ph of phases) {
    const deadline = Date.now() + ph.secs * 1000;
    console.log(`  phase: ${ph.vus} concurrent for ${ph.secs}s`);
    await Promise.all(Array.from({ length: ph.vus }, () => worker(mtok, deadline)));
  }
  const totalSecs = (Date.now() - t0) / 1000;

  // Cleanup created patients
  console.log(`\nCleaning up ${created.length} created Patients...`);
  for (const id of created) await httpReq('DELETE', `/fhir/R4/Patient/${id}`, { medplumToken: mtok });

  // Report
  if (!samples.length) {
    // No request completed (e.g. zero-length run) — reporting on an empty set
    // would print -Infinity / NaN, so bail out cleanly instead.
    console.log('\nNo samples recorded (no requests completed).');
    console.log('RESULT: ✗ no data');
    return;
  }
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300).length;
  const errs = samples.length - ok;
  const all = samples.map((s) => s.ms);
  console.log('\n==================== SCENARIO C RESULTS ====================');
  console.log(`Total requests : ${samples.length}  (${totalSecs.toFixed(0)}s, ${(samples.length / totalSecs).toFixed(1)} req/s)`);
  console.log(`Errors         : ${errs}  (${((errs / samples.length) * 100).toFixed(2)}%)`);
  console.log(`Latency (ms)   : p50=${pct(all, 50).toFixed(0)}  p95=${pct(all, 95).toFixed(0)}  p99=${pct(all, 99).toFixed(0)}  max=${Math.max(...all).toFixed(0)}`);
  for (const op of ['search', 'create', 'metadata']) {
    const g = samples.filter((s) => s.op === op);
    const gms = g.map((s) => s.ms);
    const gok = g.filter((s) => s.status >= 200 && s.status < 300).length;
    console.log(`  ${op.padEnd(9)}: n=${g.length} ok=${gok} p50=${pct(gms, 50).toFixed(0)}ms p95=${pct(gms, 95).toFixed(0)}ms`);
  }
  console.log('============================================================');
  const errRate = errs / samples.length;
  console.log(errRate < 0.01 && pct(all, 95) < 1000 ? 'RESULT: ✓ PASS (err<1%, p95<1s)' : 'RESULT: ✗ thresholds exceeded');
}

run().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
