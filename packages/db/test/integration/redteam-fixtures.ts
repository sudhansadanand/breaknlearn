/** Shared SYNTHETIC fixtures for the A9 red-team suites: one household with a row in every household table. */
import { createHash, randomUUID } from "node:crypto";
import { MULT_TABLE_7 } from "../fixtures";
import { admin } from "./helpers";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`redteam fixture: missing ${what}`);
  return v;
}

export async function publishedVersionOf(lessonId: string): Promise<string> {
  const [pub] = await admin<{ v: string }[]>`
    select lesson_version_id as v from bnl.publication_records where lesson_id = ${lessonId} and unpublished_at is null`;
  return must(pub, `published version of ${lessonId}`).v;
}

export interface Household {
  id: string;
  owner: string;
  guardian: string;
  device: string;
  revokedDevice: string;
  learners: [string, string];
  attempt: string;
  questionKey: string;
  recommendation: string;
  upload: string;
  objectKey: string;
  pairingCodeHash: string;
}

export async function seedHousehold(label: string, versionId: string): Promise<Household> {
  const h: Household = {
    id: randomUUID(), owner: randomUUID(), guardian: randomUUID(), device: randomUUID(), revokedDevice: randomUUID(),
    learners: [randomUUID(), randomUUID()], attempt: randomUUID(), questionKey: "", recommendation: randomUUID(),
    upload: randomUUID(), objectKey: "", pairingCodeHash: sha(`code-${randomUUID()}`),
  };
  h.objectKey = `${h.id}/${randomUUID()}`;
  const keys = (await admin<{ k: string }[]>`
    select question_version_key as k from bnl.quiz_items where lesson_version_id = ${versionId} order by sort_order limit 3`).map((r) => r.k);
  h.questionKey = must(keys[0], "quiz item");
  const responseKey = must(keys[1], "second quiz item");
  const node = String(must((await admin`select id from bnl.curriculum_nodes order by stable_key limit 1`)[0], "curriculum node").id);
  const plan = randomUUID();
  const chapter = randomUUID();
  const session = randomUUID();
  const clientSession = randomUUID();
  const run = randomUUID();
  const job = randomUUID();
  await admin.begin(async (sql) => {
    await sql`insert into bnl.households (id, label) values (${h.id}, ${`SYNTHETIC A9 ${label}`})`;
    await sql`insert into bnl.household_memberships (household_id, auth_user_id, role) values
      (${h.id}, ${h.owner}, 'owner'), (${h.id}, ${h.guardian}, 'guardian')`;
    await sql`insert into bnl.paired_devices (id, household_id, label, token_version, refresh_token_hash) values
      (${h.device}, ${h.id}, 'SYNTHETIC A9 TV', 1, ${sha(`refresh-${h.device}`)})`;
    await sql`insert into bnl.paired_devices (id, household_id, label, token_version, revoked_at) values
      (${h.revokedDevice}, ${h.id}, 'SYNTHETIC A9 old TV', 2, now())`;
    await sql`insert into bnl.learner_profiles (id, household_id, slot, display_name, grade, avatar_id) values
      (${h.learners[0]}, ${h.id}, 1, ${`Synthetic ${label} One`}, 2, 'fox'), (${h.learners[1]}, ${h.id}, 2, ${`Synthetic ${label} Two`}, 6, 'tiger')`;
    await sql`insert into bnl.device_pairing_codes (pairing_id, code_hash, poll_secret_hash, household_id, approved_by, approved_at, device_id, expires_at)
      values (${randomUUID()}, ${h.pairingCodeHash}, ${sha(`poll-${h.id}`)}, ${h.id}, ${h.owner}, now(), ${h.device}, now() + interval '5 minutes')`;
    await sql`insert into bnl.consent_records (household_id, guardian_auth_user_id, consent_version) values (${h.id}, ${h.owner}, 'synthetic-v1')`;
    await sql`insert into bnl.migration_runs (id, household_id, device_id, migration_run_id, legacy_fingerprint) values
      (${run}, ${h.id}, ${h.device}, ${randomUUID()}, ${sha(`fp-${h.id}`)})`;
    await sql`insert into bnl.migration_aliases (household_id, device_id, local_profile_id, learner_id, migration_run_id, legacy_fingerprint) values
      (${h.id}, ${h.device}, 'child-1', ${h.learners[0]}, ${run}, ${sha(`fp-${h.id}`)})`;
    await sql`insert into bnl.school_plans (id, household_id, grade, subject_key, academic_year, school_label) values
      (${plan}, ${h.id}, 2, 'math', '2026-27', 'SYNTHETIC School')`;
    await sql`insert into bnl.syllabus_uploads (id, household_id, school_plan_id, object_key, sha256, original_filename, mime_type, size_bytes)
      values (${h.upload}, ${h.id}, ${plan}, ${h.objectKey}, ${sha(`upload-${h.id}`)}, 'synthetic-private.pdf', 'application/pdf', 100)`;
    await sql`insert into bnl.import_jobs (id, household_id, school_plan_id, upload_id, job_type, status) values
      (${job}, ${h.id}, ${plan}, ${h.upload}, 'csv', 'review')`;
    await sql`insert into bnl.syllabus_chapters (id, household_id, school_plan_id, upload_id, title, sort_order) values
      (${chapter}, ${h.id}, ${plan}, ${h.upload}, 'SYNTHETIC chapter', 1)`;
    await sql`insert into bnl.chapter_topic_mappings (household_id, chapter_id, curriculum_node_id, confidence) values
      (${h.id}, ${chapter}, ${node}, 0.5)`;
    await sql`insert into bnl.learning_sessions (id, household_id, learner_id, device_id, client_session_id, started_at) values
      (${session}, ${h.id}, ${h.learners[0]}, ${h.device}, ${clientSession}, now())`;
    await sql`insert into bnl.learning_events (event_id, household_id, learner_id, device_id, session_id, client_session_id, client_sequence,
      event_type, schema_version, lesson_id, occurred_at, payload) values
      (${randomUUID()}, ${h.id}, ${h.learners[0]}, ${h.device}, ${session}, ${clientSession}, 1, 'lesson_started', 1, ${MULT_TABLE_7}, now(), ${sql.json({ theme_key: "farm" })})`;
    await sql`insert into bnl.learner_progress (household_id, learner_id, lesson_id, theme_key, attempt_id, slide_id, client_revision) values
      (${h.id}, ${h.learners[0]}, ${MULT_TABLE_7}, 'farm', ${randomUUID()}, 'step-3', 1)`;
    await sql`insert into bnl.assessment_attempts (id, household_id, learner_id, device_id, lesson_id, lesson_version_id, client_attempt_id,
      stage, seed, question_keys) values
      (${h.attempt}, ${h.id}, ${h.learners[0]}, ${h.device}, ${MULT_TABLE_7}, ${versionId}, ${randomUUID()}, 'immediate', 'seed', ${sql.json(keys)})`;
    await sql`insert into bnl.question_responses (household_id, attempt_id, learner_id, question_version_key, selected_option_id, correct) values
      (${h.id}, ${h.attempt}, ${h.learners[0]}, ${responseKey}, 'a', false)`;
    await sql`insert into bnl.review_schedule (household_id, learner_id, lesson_id, source_attempt_id, due_at) values
      (${h.id}, ${h.learners[0]}, ${MULT_TABLE_7}, ${h.attempt}, now() + interval '3 days')`;
    await sql`insert into bnl.mastery_snapshots (household_id, learner_id, score_date, score, status, confidence, components, weights_version) values
      (${h.id}, ${h.learners[0]}, current_date, 50, 'provisional', 'low', ${sql.json({ M: 50, R: null, I: null, C: 100 })}, 'a9-redteam')`;
    await sql`insert into bnl.recommendations (id, household_id, learner_id, reason_code, suggested_lesson_id) values
      (${h.recommendation}, ${h.id}, ${h.learners[0]}, 'insufficient_evidence_take_quiz', ${MULT_TABLE_7})`;
    await sql`insert into bnl.audit_logs (household_id, action, target_type, actor_type) values (${h.id}, 'a9.redteam_fixture', 'household', 'system')`;
    await sql`insert into bnl.idempotency_keys (key, scope, actor_or_device, household_id, request_sha256, status_code) values
      (${`a9-${randomUUID()}`}, 'telemetry_batch', ${h.device}, ${h.id}, ${sha("req")}, 200)`;
    await sql`insert into bnl.data_deletion_requests (household_id, requested_by, scope) values (${h.id}, ${h.owner}, 'telemetry_only')`;
  });
  return h;
}


/** Deletes a seeded household (children without cascading FKs first). */
export async function dropHousehold(id: string): Promise<void> {
  await admin.begin(async (sql) => {
    for (const t of ["question_responses", "review_schedule", "assessment_attempts", "learning_events", "learning_sessions",
      "migration_aliases", "migration_runs", "device_pairing_codes", "audit_logs", "idempotency_keys"]) {
      await sql.unsafe(`delete from bnl.${t} where household_id = $1`, [id]);
    }
    await sql`delete from bnl.households where id = ${id}`;
  });
}
