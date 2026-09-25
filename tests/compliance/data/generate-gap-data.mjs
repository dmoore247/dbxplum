#!/usr/bin/env node
// Generate US Core v7-conformant resources that fill the specific gaps the
// standard Inferno reference bundles leave, so these us_core_v700 tests pass
// instead of skipping:
//   1. average_blood_pressure_must_support        → BP Observation w/ component.dataAbsentReason
//   2. average_blood_pressure_provenance_revinclude → Provenance targeting that Observation
//   3. practitioner_role_must_support (endpoint)  → PractitionerRole w/ endpoint + Endpoint
//   4. clinical_note_types (11502-2, 11526-1)     → DocumentReferences of those LOINC types
//
// Reproducible: discovers a suitable Patient (+ its Practitioner/Organization)
// at runtime on whatever server it points at; pass PATIENT_ID to pin one.
// Auth: Databricks gateway Bearer + Medplum __medplum_token cookie.
import { execSync } from 'node:child_process';

const BASE = process.env.MEDPLUM_URL || 'https://medplum-server-3464092709171785.aws.databricksapps.com';
const CID = process.env.MEDPLUM_CLIENT_ID;
const CSEC = process.env.MEDPLUM_CLIENT_SECRET;
const DBX = process.env.DATABRICKS_TOKEN || execSync('databricks auth token -p FHIR', { encoding: 'utf8' }).match(/"access_token":\s*"([^"]+)"/)?.[1];
let PATIENT_ID = process.env.PATIENT_ID || '';
if (!CID || !CSEC || !DBX) { console.error('Need MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET, DATABRICKS_TOKEN'); process.exit(1); }

async function medplumToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC });
  const r = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Bearer ${DBX}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

let H;
async function fhir(method, path, body) {
  const r = await fetch(`${BASE}/fhir/R4${path}`, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  return { status: r.status, json, txt };
}
async function search(path) { const { json } = await fhir('GET', path); return json?.entry?.map((e) => e.resource) ?? []; }
async function create(res) {
  const { status, json, txt } = await fhir('POST', `/${res.resourceType}`, res);
  if (status >= 200 && status < 300) { console.log(`  ✓ created ${res.resourceType}/${json.id}`); return json; }
  console.log(`  ✗ ${res.resourceType} → HTTP ${status}: ${txt.slice(0, 200)}`); return null;
}

async function main() {
  H = {
    Authorization: `Bearer ${DBX}`,
    Cookie: `__medplum_token=${await medplumToken()}`,
    'Content-Type': 'application/fhir+json',
    Accept: 'application/fhir+json',
  };

  // Discover a patient (richest by default: one that already has Observations).
  if (!PATIENT_ID) {
    const obs = await search('/Observation?_count=1&code=8302-2'); // any body-height obs
    PATIENT_ID = obs[0]?.subject?.reference?.replace('Patient/', '') ||
      (await search('/Patient?_count=1'))[0]?.id;
  }
  if (!PATIENT_ID) throw new Error('no patient found to attach gap data to');
  console.log(`Target patient: Patient/${PATIENT_ID}`);
  const patientRef = `Patient/${PATIENT_ID}`;
  const enc = (await search(`/Encounter?patient=${PATIENT_ID}&_count=1`))[0];
  const encRef = enc ? `Encounter/${enc.id}` : undefined;
  // A practitioner the patient references (via an Encounter participant), so
  // resources we author are reachable from the patient compartment.
  const prac0 = enc?.participant?.map((p) => p.individual?.reference)
    .find((r) => r && r.startsWith('Practitioner/'))?.replace('Practitioner/', '')
    || (await search(`/Practitioner?_count=1`))[0]?.id;

  // ---- Gap 1: US Core AVERAGE Blood Pressure with component.dataAbsentReason
  // NOTE: "Average Blood Pressure" is a distinct US Core profile from regular
  // Blood Pressure. Panel code 96607-7; components 96608-5 (systolic avg) and
  // 96609-3 (diastolic avg) — NOT 85354-9/8480-6/8462-4.
  // The must-support test needs the SET of average-BP observations to
  // collectively show: effectivePeriod, component.valueQuantity,
  // component.dataAbsentReason, systolic.value[x] AND diastolic.value[x].
  // One resource can't have diastolic both valued and absent, so create TWO:
  // (a) both components valued (uses effectivePeriod); (b) diastolic absent.
  console.log('\n[1] Average Blood Pressure Observations (fully-valued + dataAbsentReason)');
  const avgBpBase = (component) => ({
    resourceType: 'Observation',
    meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-average-blood-pressure|7.0.0'] },
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '96607-7', display: 'Blood pressure panel - Mean blood pressure' }], text: 'Average blood pressure' },
    subject: { reference: patientRef },
    ...(encRef ? { encounter: { reference: encRef } } : {}),
    effectivePeriod: { start: '2024-06-01T09:30:00-04:00', end: '2024-06-01T09:45:00-04:00' },
    component,
  });
  const sysComp = (v) => ({ code: { coding: [{ system: 'http://loinc.org', code: '96608-5', display: 'Systolic blood pressure - mean' }] }, valueQuantity: { value: v, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } });
  const diaValued = { code: { coding: [{ system: 'http://loinc.org', code: '96609-3', display: 'Diastolic blood pressure - mean' }] }, valueQuantity: { value: 76, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } };
  const diaAbsent = { code: { coding: [{ system: 'http://loinc.org', code: '96609-3', display: 'Diastolic blood pressure - mean' }] }, dataAbsentReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason', code: 'not-performed', display: 'Not Performed' }] } };
  // (a) both components valued
  const bp = await create(avgBpBase([sysComp(118), diaValued]));
  // (b) diastolic absent → exercises component.dataAbsentReason
  await create(avgBpBase([sysComp(120), diaAbsent]));

  // ---- Gap 2: Provenance targeting the BP observation (revinclude) ----
  if (bp) {
    console.log('\n[2] Provenance targeting the Observation');
    const org = (await search('/Organization?_count=1'))[0];
    await create({
      resourceType: 'Provenance',
      meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-provenance|7.0.0'] },
      target: [{ reference: `Observation/${bp.id}` }],
      recorded: '2024-06-01T09:35:00-04:00',
      agent: [{
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author', display: 'Author' }] },
        who: org ? { reference: `Organization/${org.id}` } : { display: 'Gap Data Generator' },
      }],
    });
  }

  // ---- Gap 2b: regular Blood Pressure (85354-9) with dataAbsentReason ----
  // The regular us-core-blood-pressure must-support also wants component
  // dataAbsentReason. Create a fully-valued one + an absent-diastolic one.
  console.log('\n[2b] Blood Pressure (85354-9): valued + dataAbsentReason');
  const rbpBase = (comp) => ({
    resourceType: 'Observation',
    meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure|7.0.0'] },
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel with all children optional' }], text: 'Blood pressure' },
    subject: { reference: patientRef }, ...(encRef ? { encounter: { reference: encRef } } : {}),
    effectiveDateTime: '2024-06-02T08:00:00-04:00', component: comp,
  });
  const rSys = (v) => ({ code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: v, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } });
  const rSysAbsent = { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, dataAbsentReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason', code: 'not-performed', display: 'Not Performed' }] } };
  const rDiaVal = { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: 80, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } };
  const rDiaAbsent = { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, dataAbsentReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason', code: 'not-performed', display: 'Not Performed' }] } };
  await create(rbpBase([rSys(122), rDiaVal]));           // both valued
  const rbpAbsent = await create(rbpBase([rSys(124), rDiaAbsent])); // diastolic absent
  await create(rbpBase([rSysAbsent, rDiaVal]));          // systolic absent (systolic.dataAbsentReason)
  if (rbpAbsent) {
    const org = (await search('/Organization?_count=1'))[0];
    await create({
      resourceType: 'Provenance',
      meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-provenance|7.0.0'] },
      target: [{ reference: `Observation/${rbpAbsent.id}` }], recorded: '2024-06-02T08:05:00-04:00',
      agent: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author' }] }, who: org ? { reference: `Organization/${org.id}` } : { display: 'Gap Generator' } }],
    });
  }

  // ---- Gap 2c: QuestionnaireResponse must-support (item.answer variants) ----
  console.log('\n[2c] QuestionnaireResponse with must-support elements + Provenance');
  const qr = await create({
    resourceType: 'QuestionnaireResponse',
    meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-questionnaireresponse|7.0.0'] },
    identifier: { system: 'urn:gap:qr', value: 'gap-qr-1' },
    status: 'completed',
    questionnaire: 'http://hl7.org/fhir/us/core/Questionnaire/us-core-sdoh-questionnaire-example',
    // Primitive extension on `questionnaire` carrying the must-support
    // questionnaireDisplay (US Core us-core-extension-questionnaire-uri group).
    _questionnaire: {
      extension: [
        { url: 'http://hl7.org/fhir/StructureDefinition/display', valueString: 'US Core SDOH Questionnaire Example' },
        { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-extension-questionnaire-uri', valueUri: 'http://hl7.org/fhir/us/core/Questionnaire/us-core-sdoh-questionnaire-example' },
      ],
    },
    subject: { reference: patientRef }, ...(encRef ? { encounter: { reference: encRef } } : {}),
    authored: '2024-06-02T09:00:00-04:00',
    ...(prac0 ? { author: { reference: `Practitioner/${prac0}` } } : {}),
    item: [
      { linkId: '1', text: 'String answer', answer: [{ valueString: 'No transportation barriers' }] },
      { linkId: '2', text: 'Coded answer', answer: [{ valueCoding: { system: 'http://loinc.org', code: 'LA32-8', display: 'No' } }] },
      // answer with a NESTED item (item.answer.item must-support element)
      { linkId: '3', text: 'Answer with nested item', answer: [{
        valueString: 'Yes',
        item: [{ linkId: '3.1', text: 'Follow-up detail', answer: [{ valueString: 'details here' }] }],
      }] },
    ],
  });
  if (qr) {
    const org = (await search('/Organization?_count=1'))[0];
    await create({
      resourceType: 'Provenance',
      meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-provenance|7.0.0'] },
      target: [{ reference: `QuestionnaireResponse/${qr.id}` }], recorded: '2024-06-02T09:05:00-04:00',
      agent: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author' }] }, who: org ? { reference: `Organization/${org.id}` } : { display: 'Gap Generator' } }],
    });
  }

  // ---- Gap 3: endpoint-bearing PractitionerRole for EVERY referenced
  // practitioner across ALL target patients. The must-support test resolves
  // practitioners across the whole patient_ids set and evaluates one resulting
  // PractitionerRole; if ANY referenced practitioner has a PR without an
  // endpoint (or no PR at all), the check can land on it and skip. So ensure
  // each referenced practitioner has at least one PR WITH an endpoint.
  // Set TARGET_PATIENTS (comma-separated) to the full suite patient list; if
  // unset, falls back to the single PATIENT_ID.
  console.log('\n[3] PractitionerRole+Endpoint for all referenced practitioners');
  const org2 = (await search('/Organization?_count=1'))[0];
  const targetPatients = (process.env.TARGET_PATIENTS || PATIENT_ID).split(',').map((s) => s.trim()).filter(Boolean);
  const practitioners = new Set();
  for (const pid of targetPatients) {
    const encs = await search(`/Encounter?patient=${pid}&_count=100`);
    for (const e of encs) {
      for (const p of e.participant || []) {
        const r = p.individual?.reference;
        if (r?.startsWith('Practitioner/')) practitioners.add(r.replace('Practitioner/', ''));
      }
    }
  }
  console.log(`  ${practitioners.size} distinct referenced practitioner(s) across ${targetPatients.length} patient(s)`);
  for (const prac of practitioners) {
    // Skip if this practitioner already has a PR with an endpoint.
    const existing = await search(`/PractitionerRole?practitioner=${prac}`);
    if (existing.some((pr) => Array.isArray(pr.endpoint) && pr.endpoint.length)) continue;
    const ep = await create({
      resourceType: 'Endpoint', status: 'active',
      connectionType: { system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest' },
      payloadType: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'any' }] }],
      address: 'https://example.org/fhir',
    });
    if (!ep) continue;
    await create({
      resourceType: 'PractitionerRole',
      meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitionerrole|7.0.0'] },
      practitioner: { reference: `Practitioner/${prac}` },
      ...(org2 ? { organization: { reference: `Organization/${org2.id}` } } : {}),
      code: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '208D00000X', display: 'General Practice' }] }],
      specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '208D00000X', display: 'General Practice' }] }],
      endpoint: [{ reference: `Endpoint/${ep.id}` }],
    });
  }

  // ---- Gap 4: DocumentReference clinical-note types 11502-2 & 11526-1 ----
  console.log('\n[4] DocumentReference clinical-note types 11502-2, 11526-1');
  const author = prac0 ? { reference: `Practitioner/${prac0}` } : undefined;
  const noteContent = Buffer.from('Gap-filler clinical note for US Core compliance testing.').toString('base64');
  for (const [code, display] of [['11502-2', 'Laboratory report'], ['11526-1', 'Pathology study']]) {
    await create({
      resourceType: 'DocumentReference',
      meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-documentreference|7.0.0'] },
      status: 'current',
      type: { coding: [{ system: 'http://loinc.org', code, display }] },
      category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
      subject: { reference: patientRef },
      date: '2024-06-01T10:00:00-04:00',
      ...(author ? { author: [author] } : {}),
      content: [{ attachment: { contentType: 'text/plain', data: noteContent }, format: { system: 'http://ihe.net/fhir/ValueSet/IHE.FormatCode.codesystem', code: 'urn:ihe:iti:xds:2017:mimeTypeSufficient', display: 'mimeType Sufficient' } }],
      ...(encRef ? { context: { encounter: [{ reference: encRef }] } } : {}),
    });
  }

  // ---- Gap 5: Conditions for the two Condition search skips ----
  // (a) asserted-date search: needs a Condition carrying the assertedDate
  //     extension so Inferno can extract a value to search on. Medplum supports
  //     the search param; the reference data just lacks the extension.
  // (b) problems/health-concerns category+encounter search: needs a
  //     problem-list-item Condition WITH an encounter (the reference data's
  //     Conditions are all encounter-diagnosis).
  console.log('\n[5] Conditions: assertedDate extension + problem-list-item with encounter');
  const condBase = {
    resourceType: 'Condition',
    subject: { reference: patientRef },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed', display: 'Confirmed' }] },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertensive disorder' }], text: 'Hypertension' },
    ...(encRef ? { encounter: { reference: encRef } } : {}),
    recordedDate: '2024-06-03T08:00:00-04:00',
  };
  // (a) encounter-diagnosis Condition WITH assertedDate extension
  await create({
    ...condBase,
    meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-encounter-diagnosis|7.0.0'] },
    extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/condition-assertedDate', valueDateTime: '2024-06-03T08:00:00-04:00' }],
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }] }],
  });
  // (b) problem-list-item Condition WITH encounter + assertedDate
  await create({
    ...condBase,
    meta: { profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns|7.0.0'] },
    extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/condition-assertedDate', valueDateTime: '2024-06-03T08:05:00-04:00' }],
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }],
  });

  console.log('\nDone generating gap-filler resources.');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
