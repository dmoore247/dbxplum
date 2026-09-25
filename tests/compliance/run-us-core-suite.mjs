#!/usr/bin/env node
// Headlessly run the Inferno US Core v7 FHIR API test group against a FHIR
// endpoint (through the local auth-injecting proxy) and report pass/fail/skip.
//
// Env:
//   INFERNO_API   Inferno API base (default http://localhost/api)
//   FHIR_URL      URL Inferno should test (default the proxy as seen from the
//                 Inferno container: http://host.docker.internal:3333/fhir/R4)
//   PATIENT_IDS   comma-separated patient ids, OR MANIFEST=path to {patient_ids:[]}
//   SUITE_ID      default us_core_v700
//   OUT           write raw results JSON here (optional)
import { readFileSync, writeFileSync } from 'node:fs';

const API = process.env.INFERNO_API || 'http://localhost/api';
const FHIR_URL = process.env.FHIR_URL || 'http://host.docker.internal:3333/fhir/R4';
const SUITE = process.env.SUITE_ID || 'us_core_v700';
const GROUP = `${SUITE}-${SUITE}_fhir_api`;
const OUT = process.env.OUT || '';
let PATIENT_IDS = process.env.PATIENT_IDS || '';
if (!PATIENT_IDS && process.env.MANIFEST) {
  PATIENT_IDS = (JSON.parse(readFileSync(process.env.MANIFEST, 'utf8')).patient_ids || []).join(',');
}
if (!PATIENT_IDS) { console.error('Set PATIENT_IDS or MANIFEST'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. session
  const sess = await (await fetch(`${API}/test_sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test_suite_id: SUITE, suite_options: [{ id: 'smart_app_launch_version', value: 'smart_app_launch_2' }] }),
  })).json();
  console.log(`session: ${sess.id}`);

  // 2. start run of the FHIR API group
  const run = await (await fetch(`${API}/test_runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test_session_id: sess.id, test_group_id: GROUP, inputs: [
      { name: 'url', value: FHIR_URL },
      { name: 'patient_ids', value: PATIENT_IDS },
    ] }),
  })).json();
  if (!run.id) { console.error('failed to start run:', JSON.stringify(run).slice(0, 300)); process.exit(1); }
  console.log(`run: ${run.id} (${run.status})`);

  // 3. poll
  let status = run.status;
  for (let i = 0; i < 80 && !['done', 'cancelled', 'error'].includes(status); i++) {
    await sleep(15000);
    status = (await (await fetch(`${API}/test_runs/${run.id}`)).json()).status;
    process.stdout.write(`\r  status: ${status}   `);
  }
  console.log(`\nfinished: ${status}`);

  // 4. results
  const res = await (await fetch(`${API}/test_runs/${run.id}?include_results=true`)).json();
  if (OUT) { writeFileSync(OUT, JSON.stringify(res)); console.log(`wrote ${OUT}`); }

  const results = res.results || [];
  const tally = {};
  for (const r of results) tally[r.result] = (tally[r.result] || 0) + 1;
  const realSkips = results.filter((r) => r.result === 'skip' && (r.test_id || '').trim());
  console.log('\ntally:', JSON.stringify(tally));
  console.log(`real skips (${realSkips.length}):`);
  for (const r of realSkips) console.log(`  SKIP ${(r.test_id || '').split('-').pop()} | ${(r.result_message || '').slice(0, 80)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
