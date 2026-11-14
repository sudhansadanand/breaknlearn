/**
 * In-memory CurriculumRepo for route tests. Mimics RLS: household tables are visible only to an
 * adult context that is an active member; curriculum nodes are visible to adult and staff contexts.
 */
import { randomUUID } from "node:crypto";
import { MemoryStorage } from "@bnl/storage";
import type { DbContext, Sql } from "../../src/server/db-port";
import type { AppDeps } from "../../src/server/deps";
import type { CurriculumDeps } from "../../src/server/curriculum/deps";
import type {
  CandidateNodeRow,
  ChapterInsert,
  CurriculumRepo,
  IdempotencyRecord,
  JobInsert,
  MappingRow,
  NodeRow,
  PlanRow,
  UploadInsert,
} from "../../src/server/curriculum/types";
import { makeTestEnv, type TestEnv } from "../fakes";

export interface CurriculumStore {
  nodes: NodeRow[];
  sourceDocs: string[];
  gradeSubjects: { grade: number; subjectKey: string; authority: string }[];
  plans: PlanRow[];
  uploads: UploadInsert[];
  jobs: (JobInsert & { createdAt: Date })[];
  chapters: ChapterInsert[];
  mappings: (MappingRow & { householdId: string })[];
  idem: { scope: string; actor: string; key: string; rec: IdempotencyRecord }[];
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fake: missing row");
  return v;
}

const ctxOf = (sql: Sql): DbContext => (sql as unknown as { ctx: DbContext }).ctx;

export const NODE_IDS = {
  numbers: "0a000000-0000-4000-8000-000000000001",
  geometry: "0a000000-0000-4000-8000-000000000002",
  measurement: "0a000000-0000-4000-8000-000000000003",
  patterns: "0a000000-0000-4000-8000-000000000004",
  multiplication: "0a000000-0000-4000-8000-000000000005",
  subjectMath: "0a000000-0000-4000-8000-000000000006",
  g6geometry: "0a000000-0000-4000-8000-000000000007",
  aadritha: "0a000000-0000-4000-8000-000000000008",
} as const;
export const SOURCE_DOC = "5d0c0000-0000-4000-8000-000000000001";

function node(id: string, stableKey: string, grade: 2 | 6, subjectKey: string, nodeType: NodeRow["nodeType"], title: string, sortOrder: number, authority: NodeRow["authority"] = "editorial_unverified"): NodeRow {
  return {
    id, stableKey, parentId: null, grade, subjectKey, nodeType, title, authority, reviewStatus: "draft", sourceDocumentId: null, sourceRef: null, sortOrder,
    provenance: { origin: "proposed_from_cisce" }, createdBy: null, reviewedBy: null, reviewedAt: null,
  };
}

export function seedCurriculum(): CurriculumStore {
  return {
    nodes: [
      node(NODE_IDS.subjectMath, "grade2.math", 2, "math", "subject", "Math", 2),
      node(NODE_IDS.numbers, "grade2.math.numbers_and_number_operations", 2, "math", "topic", "Numbers and Number Operations", 1),
      node(NODE_IDS.geometry, "grade2.math.geometry", 2, "math", "topic", "Geometry", 2),
      node(NODE_IDS.measurement, "grade2.math.measurement", 2, "math", "topic", "Measurement", 3),
      node(NODE_IDS.patterns, "grade2.math.patterns", 2, "math", "topic", "Patterns", 5),
      node(NODE_IDS.multiplication, "grade2.math.multiplication", 2, "math", "topic", "Multiplication Tables", 6),
      node(NODE_IDS.g6geometry, "grade6.math.geometry", 6, "math", "topic", "Geometry", 4),
      node(NODE_IDS.aadritha, "grade2.aadritha.values", 2, "aadritha", "topic", "Values", 1, "local_enrichment"),
    ],
    sourceDocs: [SOURCE_DOC],
    gradeSubjects: [
      { grade: 2, subjectKey: "math", authority: "cisce" },
      { grade: 6, subjectKey: "math", authority: "cisce" },
      { grade: 2, subjectKey: "aadritha", authority: "local_enrichment" },
    ],
    plans: [], uploads: [], jobs: [], chapters: [], mappings: [], idem: [],
  };
}

export function fakeCurriculumRepo(env: TestEnv, cs: CurriculumStore): CurriculumRepo {
  const households = (sql: Sql): string[] => {
    const ctx = ctxOf(sql);
    if (ctx.kind === "job") return [...new Set(env.store.memberships.map((m) => m.householdId))];
    if (ctx.kind !== "adult") return [];
    return env.store.memberships.filter((m) => m.userId === ctx.userId && m.active).map((m) => m.householdId);
  };
  const sees = (sql: Sql, hh: string) => households(sql).includes(hh);
  const readsCurriculum = (sql: Sql) => ["adult", "staff", "job"].includes(ctxOf(sql).kind);
  const requireKind = (sql: Sql, kinds: DbContext["kind"][]) => {
    if (!kinds.includes(ctxOf(sql).kind)) throw Object.assign(new Error("permission denied"), { code: "42501" });
  };
  const cand = (n: NodeRow): CandidateNodeRow => ({ id: n.id, stableKey: n.stableKey, grade: n.grade, subjectKey: n.subjectKey, title: n.title, nodeType: n.nodeType, reviewStatus: n.reviewStatus });
  const sortKey = (n: NodeRow) => [n.grade, n.subjectKey, n.nodeType !== "subject" ? 1 : 0, n.sortOrder, n.stableKey] as const;
  const cmp = (a: readonly (string | number)[], b: readonly (string | number)[]) => {
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? "";
      const y = b[i] ?? "";
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
  const job = (j: JobInsert & { createdAt: Date }) => {
    const u = must(cs.uploads.find((x) => x.id === j.uploadId));
    return { id: j.id, householdId: j.householdId, schoolPlanId: j.schoolPlanId, uploadId: j.uploadId, jobType: j.jobType, status: j.status, errors: j.errors, createdAt: j.createdAt, finishedAt: j.finishedAt, objectKey: u.objectKey, mimeType: u.mimeType, sizeBytes: u.sizeBytes };
  };
  return {
    async listNodes(sql, f) {
      if (!readsCurriculum(sql)) return [];
      return cs.nodes
        .filter((n) => (f.grade === undefined || n.grade === f.grade) && (f.subjectKey === undefined || n.subjectKey === f.subjectKey) && (f.reviewStatus === undefined || n.reviewStatus === f.reviewStatus))
        .filter((n) => !f.q || n.title.toLowerCase().includes(f.q.toLowerCase()))
        .filter((n) => !f.after || cmp(sortKey(n), [f.after.grade, f.after.subjectKey, f.after.isTopic ? 1 : 0, f.after.sortOrder, f.after.stableKey]) > 0)
        .sort((a, b) => cmp(sortKey(a), sortKey(b)))
        .slice(0, f.limit)
        .map((n) => ({ ...n }));
    },
    async getNodeForUpdate(sql, id) {
      requireKind(sql, ["staff"]);
      const n = cs.nodes.find((x) => x.id === id);
      return n ? { ...n } : null;
    },
    async lastSubmitter(_sql, nodeId) {
      const rows = env.store.audit.filter((a) => a.action === "curriculum.node_submitted" && a.targetId === nodeId);
      return rows.at(-1)?.actorAuthId ?? null;
    },
    async sourceDocumentExists(_sql, id) {
      return cs.sourceDocs.includes(id);
    },
    async subjectAuthority(_sql, grade, subjectKey) {
      return cs.gradeSubjects.find((g) => g.grade === grade && g.subjectKey === subjectKey)?.authority ?? null;
    },
    async updateNodeReview(sql, u) {
      requireKind(sql, ["staff"]);
      const n = must(cs.nodes.find((x) => x.id === u.id));
      const next: NodeRow = {
        ...n,
        reviewStatus: u.reviewStatus,
        authority: u.authority ?? n.authority,
        sourceDocumentId: u.sourceDocumentId ?? n.sourceDocumentId,
        sourceRef: u.sourceRef ?? n.sourceRef,
        reviewedBy: u.reviewedBy ?? n.reviewedBy,
        reviewedAt: u.reviewedAt ?? n.reviewedAt,
        provenance: { ...n.provenance, ...(u.provenancePatch ?? {}) },
      };
      if (next.authority === "cisce_verified" && (!next.sourceDocumentId || !next.sourceRef)) throw Object.assign(new Error("check"), { code: "23514" });
      cs.nodes[cs.nodes.indexOf(n)] = next;
      return { ...next };
    },
    async candidateNodes(sql, grade) {
      if (!readsCurriculum(sql)) return [];
      return cs.nodes.filter((n) => n.grade === grade && (n.nodeType === "topic" || n.nodeType === "subtopic") && n.reviewStatus !== "archived").map(cand);
    },
    async getCandidateNode(sql, id) {
      const n = readsCurriculum(sql) ? cs.nodes.find((x) => x.id === id) : undefined;
      return n ? cand(n) : null;
    },
    async insertPlan(sql, p) {
      if (!sees(sql, p.householdId)) throw Object.assign(new Error("rls"), { code: "42501" });
      const row: PlanRow = { id: p.id, householdId: p.householdId, grade: p.grade, subjectKey: p.subjectKey, academicYear: p.academicYear, schoolLabel: p.schoolLabel, textbookTitle: p.textbookTitle, textbookEdition: p.textbookEdition, archivedAt: null, createdAt: env.deps.now() };
      cs.plans.push(row);
      return { ...row };
    },
    async getPlan(sql, id, hh) {
      const p = cs.plans.find((x) => x.id === id && x.householdId === hh && sees(sql, x.householdId));
      return p ? { ...p } : null;
    },
    async listPlans(sql, hh) {
      return cs.plans.filter((p) => p.householdId === hh && sees(sql, hh)).map((p) => ({ ...p }));
    },
    async findDuplicate(sql, planId, sha) {
      const u = cs.uploads.find((x) => x.schoolPlanId === planId && x.sha256 === sha && sees(sql, x.householdId));
      if (!u) return null;
      return { uploadId: u.id, jobId: cs.jobs.find((j) => j.uploadId === u.id)?.id ?? null };
    },
    async insertUpload(sql, u) {
      if (!sees(sql, u.householdId) || !u.objectKey.startsWith(`${u.householdId}/`)) throw Object.assign(new Error("rls"), { code: "42501" });
      if (cs.uploads.some((x) => x.schoolPlanId === u.schoolPlanId && x.sha256 === u.sha256)) throw Object.assign(new Error("dup"), { code: "23505" });
      cs.uploads.push({ ...u });
    },
    async insertJob(sql, j) {
      if (!sees(sql, j.householdId)) throw Object.assign(new Error("rls"), { code: "42501" });
      cs.jobs.push({ ...j, createdAt: env.deps.now() });
    },
    async insertChapters(sql, rows) {
      for (const r of rows) {
        if (!sees(sql, r.householdId)) throw Object.assign(new Error("rls"), { code: "42501" });
        cs.chapters.push({ ...r });
      }
    },
    async insertSuggestions(sql, rows) {
      for (const r of rows) {
        if (!sees(sql, r.householdId)) throw Object.assign(new Error("rls"), { code: "42501" });
        cs.mappings.push({ id: randomUUID(), householdId: r.householdId, chapterId: r.chapterId, curriculumNodeId: r.curriculumNodeId, state: "suggested", confidence: r.confidence, reviewerAuthId: null, reviewedAt: null });
      }
    },
    async getJob(sql, jobId, hh) {
      const j = cs.jobs.find((x) => x.id === jobId && x.householdId === hh && sees(sql, x.householdId));
      return j ? job(j) : null;
    },
    async listJobs(sql, hh, limit) {
      return cs.jobs.filter((j) => j.householdId === hh && sees(sql, hh)).slice(0, limit).map((j) => ({ ...job(j), chapterCount: cs.chapters.filter((c) => c.uploadId === j.uploadId).length }));
    },
    async jobChapters(sql, uploadId, hh) {
      return cs.chapters
        .filter((c) => c.uploadId === uploadId && c.householdId === hh && sees(sql, hh))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({
          id: c.id, chapterNumber: c.chapterNumber, title: c.title, pageStart: c.pageStart, sourcePage: c.sourcePage, sortOrder: c.sortOrder, extractionConfidence: c.extractionConfidence,
          mappings: cs.mappings
            .filter((m) => m.chapterId === c.id)
            .map((m) => {
              const n = must(cs.nodes.find((x) => x.id === m.curriculumNodeId));
              return { ...m, stableKey: n.stableKey, nodeTitle: n.title, authority: n.authority };
            }),
        }));
    },
    async getMappingForUpdate(sql, chapterId, nodeId, hh) {
      const m = cs.mappings.find((x) => x.chapterId === chapterId && x.curriculumNodeId === nodeId && x.householdId === hh && sees(sql, hh));
      return m ? { ...m } : null;
    },
    async decideExisting(_sql, p) {
      const m = must(cs.mappings.find((x) => x.id === p.id));
      if (m.state === "approved") throw Object.assign(new Error("immutable"), { code: "55000" });
      Object.assign(m, { state: p.state, reviewerAuthId: p.reviewer, reviewedAt: p.at });
      return { ...m };
    },
    async insertDecision(sql, p) {
      if (!sees(sql, p.householdId)) throw Object.assign(new Error("rls"), { code: "42501" });
      const row = { id: randomUUID(), householdId: p.householdId, chapterId: p.chapterId, curriculumNodeId: p.curriculumNodeId, state: p.state, confidence: null, reviewerAuthId: p.reviewer, reviewedAt: p.at };
      cs.mappings.push(row);
      return { ...row };
    },
    async getIdempotency(_sql, scope, actor, key) {
      return cs.idem.find((x) => x.scope === scope && x.actor === actor && x.key === key)?.rec ?? null;
    },
    async putIdempotency(_sql, p) {
      cs.idem.push({ scope: p.scope, actor: p.actor, key: p.key, rec: { requestSha256: p.requestSha256, statusCode: p.statusCode, response: structuredClone(p.response) } });
    },
  };
}

export interface CurriculumTestEnv extends TestEnv {
  cs: CurriculumStore;
  storage: MemoryStorage;
  cdeps: CurriculumDeps;
}

export function makeCurriculumEnv(overrides: Partial<CurriculumDeps> = {}): CurriculumTestEnv {
  const env = makeTestEnv();
  const cs = seedCurriculum();
  const base = env.deps.db;
  // Roll back the curriculum store too when a transaction throws.
  const db: AppDeps["db"] = async (ctx, fn) => {
    const snap = structuredClone(cs);
    try {
      return await base(ctx, fn);
    } catch (err) {
      Object.assign(cs, snap);
      throw err;
    }
  };
  env.deps = { ...env.deps, db };
  const storage = new MemoryStorage(() => env.clock.now);
  const cdeps: CurriculumDeps = {
    repo: fakeCurriculumRepo(env, cs),
    storage,
    localStorage: null,
    importMaxBytes: 1024 * 1024,
    signedUrlTtlSeconds: 60,
    suggestThreshold: 0.2,
    ...overrides,
  };
  return { ...env, cs, storage, cdeps };
}
