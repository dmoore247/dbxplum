# US Core test data loader

Loads US Core-conformant FHIR data into the Medplum server so the Inferno
`us_core_v700` suite has resources to read and validate.

## Data source

The official Inferno US Core reference bundles:

```sh
git clone --depth 1 https://github.com/inferno-framework/inferno-reference-server-data
# resources/uscore_bundle_patient_85.json   (267 resources — full profile set)
# resources/uscore_bundle_patient_355.json  (473 resources)
# resources/uscore_bundle_patient_907.json  (3 resources — minimal)
```

These are the same bundles the Inferno reference server (`inferno.healthit.gov`)
is seeded with, so they exercise the full US Core v7 profile set.

## Loading (`load-us-core-data.mjs`)

```sh
DATABRICKS_TOKEN=$(databricks auth token -p FHIR | jq -r .access_token) \
MEDPLUM_CLIENT_ID=<client-app-id> \
MEDPLUM_CLIENT_SECRET=<client-app-secret> \
node load-us-core-data.mjs /path/to/inferno-reference-server-data/resources/uscore_bundle_patient_85.json ...
```

Auth is the two-layer scheme (Databricks gateway Bearer + Medplum
`__medplum_token` cookie). The client must have a **FullAccessPolicy** to write.

### Three adaptations the loader makes

1. **Reference-style normalization → server-assigned UUIDs.** Medplum requires
   UUID resource ids and rejects fixed ids like `Patient/85` ("Invalid id").
   Bundles come in two reference styles: the big patients (85/355) use
   `urn:uuid:` fullUrls, while `client_test` uses literal `Patient/<id>` refs.
   The loader normalizes **every** entry to a `urn:uuid:` fullUrl + `POST`,
   builds a map from BOTH the old fullUrl AND `Type/id` → the new urn, and
   rewrites all references. Both styles then resolve correctly and Medplum
   assigns UUIDs.

2. **Rate-limit chunking.** A 473-entry bundle exceeds Medplum's rate limit
   (~50k points/window; ~121/write). The loader splits bundles into
   `CHUNK_SIZE` (default 300) transactions, carries the `urn → assigned-id`
   map across chunks and rewrites cross-chunk references, backs off on HTTP 429,
   and pauses `CHUNK_PAUSE_MS` (default 35s) between chunks.

3. **Manifest.** Set `MANIFEST=path.json` to write `{ "patient_ids": [...] }`
   with all assigned Patient UUIDs — consumed directly by `run-us-core-suite.mjs`.

## Gap-filler generator (`generate-gap-data.mjs`)

The standard reference bundles leave a few US Core must-support / clinical-note
gaps. This generator creates conformant resources to close them (discovers a
target patient + its referenced practitioner/encounter at runtime, so it works
on any branch; pass `PATIENT_ID` to pin one):

- **Average Blood Pressure** (96607-7) + **Blood Pressure** (85354-9) observations
  exercising `component.dataAbsentReason` on both systolic and diastolic
  (needs several observations — one can't have a component both valued and absent).
- **Provenance** targeting those observations (revinclude tests).
- **PractitionerRole + Endpoint** for a patient-referenced practitioner.
- **QuestionnaireResponse** with must-support `item.answer` variants + nested items.
- **DocumentReference** clinical-note types `11502-2`, `11526-1`.

```sh
DATABRICKS_TOKEN=... MEDPLUM_CLIENT_ID=... MEDPLUM_CLIENT_SECRET=... \
PATIENT_ID=<uuid> node generate-gap-data.mjs
```

## Target / caveat

Writes go to wherever the Medplum client's project is backed — for the deployed
`medplum-server` app that is Lakebase **`projects/medplum/branches/production`**.
This is shared, persistent state. Resources are deletable via
`DELETE Patient/<id>?_cascade=delete` (note: in testing, cascade removed the
Patient but not all descendants — orphaned children may remain and are harmless
to the suite).
