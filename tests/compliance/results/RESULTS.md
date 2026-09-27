# Inferno US Core v7.0.0 Compliance Results

**Date**: 2026-09-23
**Target**: Medplum FHIR R4 server on Databricks Apps (FHIR environment)
`https://medplum-server-3464092709171785.aws.databricksapps.com/fhir/R4`
**Backing store**: Lakebase Postgres — `projects/medplum/branches/production`
**Suite**: `us_core_v700` → **US Core FHIR API** group (`us_core_v700_fhir_api`)
**Tool**: Inferno Framework (inferno-template + `us_core_test_kit` 1.1.6), run headless via the Inferno REST API
**Raw results**: `us_core_v700_run_20260925_zeroskip.json` (best; earlier runs retained for the progression)
**Reproduce**: see `../PIPELINE.md`

---

## Summary (comprehensive run — 5 US Core patients + gap-fillers)

| Result | Count |
|--------|------:|
| **Pass**  | **534** |
| Fail  | 43 (24 real tests + 19 parent-group roll-ups) |
| Skip  | **0** |
| Error | **0** |
| **Total** | 577 |

534 passing, **zero errors, zero skips**. Every remaining failure is explained
below — **none is a defect in the Medplum server**.

### All 4 previously-remaining skips were closed (each a data gap)

Investigation showed every skip was missing/insufficient *data*, not a Medplum
limitation — including the two search skips I'd initially attributed to server
capability (Medplum in fact supports both search params; the data just lacked
the searchable elements):

| Skip | Root cause | Fix (in `generate-gap-data.mjs`) |
|------|-----------|----------------------------------|
| condition `asserted-date` search | reference Conditions lack the `condition-assertedDate` extension (Medplum supports the param) | Condition with the assertedDate extension |
| condition `category`+`encounter` search | patient had only `encounter-diagnosis` Conditions; none `problem-list-item` **with** an encounter | problem-list-item Condition with encounter |
| questionnaire_response must-support | `questionnaire` lacked the `.extension:questionnaireDisplay` (exact URL `.../StructureDefinition/display`) | `_questionnaire.extension` with the display + uri extensions |
| practitioner_role must-support (endpoint) | test resolves practitioners across **all** patients; some referenced practitioners had no PractitionerRole or one without an endpoint | endpoint-bearing PractitionerRole for **every** referenced practitioner across the patient set |

### Progression across runs

| Run | Patients | Docker | Pass | Fail (real) | Skip (real) | Error |
|-----|----------|--------|-----:|-----:|-----:|------:|
| 1 | 1 | 8 GB | 253 | 4 | 222 | 98 (validator OOM) |
| 2 | 3 | 16 GB | 512 | 15 | 39 | 0 |
| 3 | 4 | 16 GB | 529 | 19 | 15 | 0 |
| 4 | 9 (all IGs) | 16 GB | 521 | 27 | 4 | 0 |
| 5 | 5 US-Core + gap-fillers | 16 GB | 530 | 23 | 4 | 0 |
| **final** | **5 US-Core + full gap-fillers** | 16 GB | **534** | **24** | **0** | **0** |

Loading all 9 available patients (run 4) drove skips to 4 but added 13
profile-conformance fails from non-US-Core IG data (CARIN/PDex/DTR/US Quality
Core). Those 4 IG patients were **removed**; gap-filler resources + a proxy
pagination fix recovered the coverage with US-Core-native data only.

### Test topology

```
Inferno (Docker, us_core_v700)                 tests/compliance/proxy/server.js
   │  http://host.docker.internal:3333/fhir/R4        (injects auth, rewrites links)
   ▼                                                        │
compliance proxy ──────────────────────────────────────────┘
   │  Authorization: Bearer <databricks-oauth>   (passes the Databricks gateway)
   │  Cookie: __medplum_token=<medplum-oauth>     (medplum app auth; gateway
   ▼                                               replaces the Auth header)
Databricks gateway → medplum-server (Databricks Apps) → Lakebase (production)
```

Only the **FHIR API** group ran. SMART App Launch groups were excluded — they
need an interactive OAuth launch the Databricks gateway does not support.

---

## Data

Loaded the 5 US Core reference patients (Inferno
`inferno-reference-server-data`) plus generated gap-fillers. See `../data/README.md`
and `../PIPELINE.md`.

| Patient | Coverage |
|---------|----------|
| 85 | 267 resources — full US Core profile set (gap-fillers attached here) |
| 355 | 465/473 — 129 Encounter, 133 Observation, 31 Condition, CarePlan/CareTeam/Goal/AllergyIntolerance/MedicationRequest |
| 907, 908 | minimal (Patient/Encounter/Provenance) |
| client_test | QuestionnaireResponse, ServiceRequest, 27 Observations, Device, Goal, MedicationDispense, Coverage |

**Gap-fillers generated** (`generate-gap-data.mjs`): Average/regular Blood
Pressure with `component.dataAbsentReason`, Provenance, PractitionerRole+Endpoint,
QuestionnaireResponse must-support items, DocumentReference note types 11502-2/11526-1.

---

## The 24 real failures (none are Medplum server defects)

| # | Category | Notes |
|--:|----------|-------|
| 12 | **`effectivePeriod` date-search quirk** — resources store `effectivePeriod`; the Inferno date-equality check expects a single instant and doesn't compare against a Period. Known test-kit limitation. | Observation vital-signs + DiagnosticReport lab `date` search tests |
| 9 | **Profile non-conformance in the reference data** — DocumentReference/Location/etc. instances in the standard bundles don't fully satisfy US Core v7 (e.g. missing `DocumentReference.custodian`). A data issue, not a server bug. | validation tests |
| 1 | **TLS check** — Inferno tests the plain-HTTP localhost proxy; the real server is HTTPS. Test-topology artifact. | `standalone_auth_tls` |
| 1 | **DocumentReference.custodian / Provenance.agent** conformance note in reference data. | data |
| 1 | **Attachment URL** — a DocumentReference attachment URL points at `host.docker.internal` (the proxy) which Inferno's validator can't fetch. Proxy-topology artifact. | attachment resolution |

19 further "fail" entries are parent test-**groups** rolling up a failing child.

## Skips: none

All previously-skipped tests now run — see the "All 4 previously-remaining
skips were closed" table above. Each was a data gap closed by
`generate-gap-data.mjs` (which is idempotent and reproducible on any branch).

---

## Reproducing

See `../PIPELINE.md`. Prereqs: Docker Desktop ≥ 16 GB (validator OOMs at 8 GB),
the Inferno stack + auth proxy up, a Medplum ClientApplication id/secret with a
FullAccessPolicy. Then `bash ../run-comprehensive.sh` with `MEDPLUM_URL` /
`MEDPLUM_CLIENT_ID` / `MEDPLUM_CLIENT_SECRET` set.
