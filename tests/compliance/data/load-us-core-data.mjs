#!/usr/bin/env node
// Load US Core transaction bundles into Medplum via the Databricks-gated proxy path.
// Auth: Databricks gateway Bearer (Authorization) + Medplum token via __medplum_token cookie.
//
// Handles Medplum's rate limit by splitting each bundle into CHUNK_SIZE-entry
// transactions, carrying a urn:uuid -> real-id map across chunks and rewriting
// cross-chunk references, with 429 backoff and a pause between chunks.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.MEDPLUM_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
const CID = process.env.MEDPLUM_CLIENT_ID;
const CSEC = process.env.MEDPLUM_CLIENT_SECRET;
const DBX = process.env.DATABRICKS_TOKEN || execSync('databricks auth token -p FHIR', { encoding: 'utf8' }).match(/"access_token":\s*"([^"]+)"/)?.[1];
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '300', 10);
const CHUNK_PAUSE_MS = parseInt(process.env.CHUNK_PAUSE_MS || '35000', 10);
const files = process.argv.slice(2);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!CID || !CSEC || !DBX) { console.error('Need MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET, DATABRICKS_TOKEN'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function medplumToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC });
  const r = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${DBX}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

// Rewrite any reference string that is a urn:uuid already resolved in `map`.
function rewriteRefs(obj, map) {
  if (Array.isArray(obj)) { obj.forEach((x) => rewriteRefs(x, map)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'reference' && typeof v === 'string' && map.has(v)) obj[k] = map.get(v);
      else rewriteRefs(v, map);
    }
  }
}

// Collect every urn:uuid this resource references (into `out`).
function collectUrnRefs(obj, out) {
  if (Array.isArray(obj)) { obj.forEach((x) => collectUrnRefs(x, out)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'reference' && typeof v === 'string' && v.startsWith('urn:uuid:')) out.add(v);
      else collectUrnRefs(v, out);
    }
  }
}

// Topologically order entries so a referenced resource is created no later than
// the entry that references it. Chunking then only ever produces backward
// cross-chunk references (resolved via the id `map`) or same-chunk references
// (resolved inside the transaction). A forward reference — to a urn: that lands
// in a later chunk — is unresolvable and would fail that entry; this ordering
// eliminates them for any acyclic bundle regardless of the input entry order.
// Cycles (rare in US Core data) are broken best-effort and left in place.
function topoSort(entries) {
  const n = entries.length;
  // Map each urn:uuid fullUrl to its entry index so references resolve to
  // positions. Duplicate fullUrls are rare/malformed (last one wins as the
  // reference target); entries with no fullUrl simply aren't referenceable.
  const idxByUrn = new Map();
  entries.forEach((e, i) => { if (typeof e.fullUrl === 'string') idxByUrn.set(e.fullUrl, i); });
  // For each entry, the indices of the in-bundle resources it references.
  const deps = entries.map((e, i) => {
    const refs = new Set();
    collectUrnRefs(e.resource, refs);
    const out = [];
    for (const u of refs) { const j = idxByUrn.get(u); if (j !== undefined && j !== i) out.push(j); }
    return out;
  });
  // Iterative post-order DFS over indices (an explicit stack, not recursion, so
  // a long reference chain can't overflow the call stack). Every index is
  // emitted exactly once, so ALL entries are always posted — regardless of
  // missing or duplicate fullUrls — with referenced resources ordered before
  // the entries that reference them. Cycles are broken by the on-stack check.
  const ordered = [];
  const done = new Array(n).fill(false);
  const onStack = new Array(n).fill(false);
  for (let s = 0; s < n; s++) {
    if (done[s]) continue;
    const stack = [{ i: s, k: 0 }];
    onStack[s] = true;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = deps[frame.i];
      if (frame.k < children.length) {
        const child = children[frame.k++];
        if (done[child] || onStack[child]) continue; // visited or cycle edge
        onStack[child] = true;
        stack.push({ i: child, k: 0 });
      } else {
        onStack[frame.i] = false;
        done[frame.i] = true;
        ordered.push(entries[frame.i]); // dependencies emitted before dependents
        stack.pop();
      }
    }
  }
  return ordered;
}

async function postTransaction(entries, headers, map) {
  const bundle = { resourceType: 'Bundle', type: 'transaction', entry: entries };
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${BASE}/fhir/R4`, { method: 'POST', headers, body: JSON.stringify(bundle) });
    const txt = await r.text();
    if (r.status === 429) {
      const wait = 35000;
      process.stdout.write(`[429, waiting ${wait / 1000}s] `);
      await sleep(wait);
      continue;
    }
    if (!r.ok) return { ok: 0, err: entries.length, sample: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    const resp = JSON.parse(txt);
    let ok = 0, err = 0, sample = '';
    resp.entry?.forEach((e, i) => {
      const s = e.response?.status ?? '';
      if (/^2\d\d/.test(s)) {
        ok++;
        const loc = (e.response?.location ?? '').match(/^([A-Za-z]+\/[0-9a-f-]+)/i)?.[1];
        const origFull = entries[i]?.fullUrl;
        if (loc && origFull) map.set(origFull, loc);
      } else {
        err++;
        if (!sample) sample = s + ' ' + (e.response?.outcome?.issue?.[0]?.diagnostics ?? '').slice(0, 160);
      }
    });
    return { ok, err, sample };
  }
  return { ok: 0, err: entries.length, sample: 'exhausted 429 retries' };
}

const MANIFEST = process.env.MANIFEST || '';   // if set, write {patient_ids:[...]} JSON here
const allPatientIds = [];

async function main() {
  const mtok = await medplumToken();
  console.log(`Medplum token ok (${mtok.length} chars)`);
  const headers = {
    'Authorization': `Bearer ${DBX}`,
    'Cookie': `__medplum_token=${mtok}`,
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
  };

  for (const f of files) {
    const bundle = JSON.parse(readFileSync(f, 'utf8'));
    const all = bundle.entry ?? [];
    // Normalize the bundle so every entry is a POST with a stable urn:uuid
    // fullUrl, and every reference (whether it was urn:uuid: or a literal
    // "Type/id") points at that urn. This makes both bundle styles work:
    //   - 85/355: already urn:uuid: fullUrls  → map old fullUrl → urn (identity)
    //   - client_test: literal "Type/id" refs → map "Type/id" → urn
    // Medplum requires UUID ids and rejects fixed ids, so PUT<->id is dropped;
    // the transaction resolves the urn references and assigns real UUIDs.
    const refMap = new Map();
    for (const e of all) {
      const rt = e.resource?.resourceType;
      const oldId = e.resource?.id;
      const urn = (e.fullUrl && e.fullUrl.startsWith('urn:uuid:'))
        ? e.fullUrl
        : `urn:uuid:${randomUUID()}`;
      if (e.fullUrl) refMap.set(e.fullUrl, urn);
      if (rt && oldId) refMap.set(`${rt}/${oldId}`, urn);
      e.fullUrl = urn;
      delete e.resource.id;
      e.request = { method: 'POST', url: rt };
    }
    // Rewrite every reference in every resource to the normalized urn.
    all.forEach((e) => rewriteRefs(e.resource, refMap));
    // Order so referenced resources never fall into a later chunk than their
    // referencer (otherwise the forward urn: reference can't be resolved).
    const ordered = topoSort(all);

    console.log(`\n=== ${f}: ${ordered.length} entries, ${Math.ceil(ordered.length / CHUNK_SIZE)} chunk(s) ===`);
    const map = new Map();
    let totOk = 0, totErr = 0; const patientIds = [];
    for (let i = 0; i < ordered.length; i += CHUNK_SIZE) {
      const chunk = ordered.slice(i, i + CHUNK_SIZE);
      chunk.forEach((e) => rewriteRefs(e.resource, map));   // resolve refs to prior chunks
      process.stdout.write(`  chunk ${i / CHUNK_SIZE + 1} (${chunk.length})... `);
      const { ok, err, sample } = await postTransaction(chunk, headers, map);
      console.log(`ok=${ok} err=${err}${sample ? ' | ' + sample : ''}`);
      totOk += ok; totErr += err;
      chunk.forEach((e) => { if (e.resource?.resourceType === 'Patient' && map.has(e.fullUrl)) patientIds.push(map.get(e.fullUrl)); });
      if (i + CHUNK_SIZE < ordered.length) { process.stdout.write(`  pausing ${CHUNK_PAUSE_MS / 1000}s for rate window... `); await sleep(CHUNK_PAUSE_MS); console.log('done'); }
    }
    console.log(`  TOTAL ok=${totOk} err=${totErr}`);
    patientIds.forEach((id) => { console.log('  PATIENT:', id); allPatientIds.push(id.replace(/^Patient\//, '')); });
  }
  if (MANIFEST) {
    writeFileSync(MANIFEST, JSON.stringify({ patient_ids: allPatientIds }, null, 2));
    console.log(`\nWrote manifest (${allPatientIds.length} patient ids): ${MANIFEST}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
