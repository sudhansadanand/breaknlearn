/**
 * In-memory ContentRepo for route tests. It mimics the SQL workflow functions closely enough to
 * exercise handler rules (roles, states, idempotency); the real functions are covered by
 * test/integration/content-*.test.ts.
 */
import { randomUUID } from "node:crypto";
import type { LessonStatus } from "@bnl/contracts";
import type { BankItem } from "@bnl/lesson-engine";
import type { Sql } from "../../src/server/db-port";
import type { ContentRepo, LessonRow, ManifestRow, PublicationRow, VersionRow } from "../../src/server/content/types";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface ContentStore {
  lessons: Mutable<LessonRow>[];
  versions: Mutable<VersionRow>[];
  items: { versionId: string; item: BankItem }[];
  publications: Mutable<PublicationRow & { lessonId: string }>[];
  manifests: (ManifestRow & { grade: 2 | 6; pinnedFrom: number | null; createdAt: Date })[];
  idempotency: { scope: string; actor: string; key: string; hash: string; status: number | null; body: unknown }[];
  calls: string[];
}

const dbError = (code: string) => Object.assign(new Error(`fake sql ${code}`), { code });

export function emptyContentStore(): ContentStore {
  return { lessons: [], versions: [], items: [], publications: [], manifests: [], idempotency: [], calls: [] };
}

export function fakeContentRepo(store: ContentStore, staffRoles: (userId: string) => string[]): ContentRepo {
  const requireRole = (actor: string, role: string) => {
    if (!staffRoles(actor).includes(role)) throw dbError("42501");
  };
  const writeManifest = (grade: 2 | 6, pinnedFrom: number | null) => {
    const revision = (store.manifests.at(-1)?.revision ?? 0) + 1;
    const live = store.publications.filter((p) => p.unpublishedAt === null);
    const checksum = `${revision}`.padStart(64, "0");
    store.manifests.push({ revision, grade, checksum, manifest: { revision, grade, live: live.map((p) => p.versionId) }, pinnedFrom, createdAt: new Date() });
    return revision;
  };
  const version = (id: string) => {
    const v = store.versions.find((x) => x.id === id);
    if (!v) throw dbError("P0002");
    return v;
  };
  return {
    async latestManifest(_sql: Sql, grade) {
      return [...store.manifests].reverse().find((m) => m.grade === grade) ?? null;
    },
    async countVisibleVersions(_sql, ids) {
      return ids.filter((id) => store.publications.some((p) => p.versionId === id && p.unpublishedAt === null)).length;
    },
    async publishedLesson(_sql, lessonId) {
      const pub = store.publications.find((p) => p.lessonId === lessonId && p.unpublishedAt === null);
      if (!pub) return null;
      const v = version(pub.versionId);
      return { id: lessonId, versionId: v.id, versionNo: v.versionNo, checksum: v.checksum, publishedAt: v.publishedAt, content: v.content };
    },
    async listLessons(_sql, p) {
      return store.lessons
        .filter((l) => p.afterKey === null || l.stableKey > p.afterKey)
        .sort((a, b) => (a.stableKey < b.stableKey ? -1 : 1))
        .slice(0, p.limit)
        .map((l) => {
          const latest = store.versions.filter((v) => v.lessonId === l.id).sort((a, b) => b.versionNo - a.versionNo)[0];
          const live = store.publications.find((x) => x.lessonId === l.id && x.unpublishedAt === null);
          return {
            ...l,
            latest: latest ? { id: latest.id, versionNo: latest.versionNo, status: latest.status, title: l.title, errorCount: latest.validationErrors.length, updatedAt: latest.updatedAt } : null,
            live: live ? { id: live.versionId, versionNo: live.versionNo } : null,
          };
        });
    },
    async getLesson(_sql, id) {
      return store.lessons.find((l) => l.id === id) ?? null;
    },
    async listVersions(_sql, lessonId) {
      return store.versions.filter((v) => v.lessonId === lessonId).sort((a, b) => b.versionNo - a.versionNo);
    },
    async getVersion(_sql, lessonId, versionId) {
      return store.versions.find((v) => v.id === versionId && v.lessonId === lessonId) ?? null;
    },
    async listPublications(_sql, lessonId) {
      return store.publications.filter((p) => p.lessonId === lessonId);
    },
    async listManifests(_sql, grade, limit) {
      return store.manifests.filter((m) => m.grade === grade).reverse().slice(0, limit)
        .map((m) => ({ revision: m.revision, grade: m.grade, checksum: m.checksum, pinnedFromRevision: m.pinnedFrom, createdAt: m.createdAt, lessonCount: 0 }));
    },
    async findTopic(_sql, key) {
      return key === "grade2.math.multiplication" ? { id: "58be84d6-b23e-5332-80a7-f7460dd3933f", grade: 2, subjectKey: "math" } : null;
    },
    async sqlContentErrors() {
      return [];
    },
    async countItems(_sql, versionId) {
      return store.items.filter((i) => i.versionId === versionId).length;
    },
    async insertLesson(_sql, p) {
      if (store.lessons.some((l) => l.stableKey === p.stableKey)) return { kind: "stable_key_taken" };
      const row: Mutable<LessonRow> = { id: randomUUID(), stableKey: p.stableKey, grade: p.grade, subjectKey: p.subjectKey, topicId: p.topicId, title: p.title, templateKey: p.templateKey, sortOrder: 1, createdBy: p.createdBy, updatedAt: new Date() };
      store.lessons.push(row);
      return { kind: "ok", row: { ...row } };
    },
    async insertVersion(_sql, p) {
      requireRole(p.createdBy, "editor");
      const now = new Date();
      const row: Mutable<VersionRow> = {
        id: randomUUID(), lessonId: p.lessonId, versionNo: p.versionNo, content: p.content, checksum: randomUUID().replace(/-/g, "").padEnd(64, "a"),
        status: "draft", validationErrors: p.validationErrors, createdBy: p.createdBy, submittedBy: null, submittedAt: null, reviewedBy: null,
        approvedAt: null, rejectedBy: null, rejectedAt: null, reviewComment: null, publishedAt: null, createdAt: now, updatedAt: now,
      };
      store.versions.push(row);
      return { ...row };
    },
    async updateDraft(_sql, p) {
      const v = version(p.versionId);
      if (v.status !== "draft") throw dbError("55000");
      Object.assign(v, { content: p.content, validationErrors: p.validationErrors, updatedAt: new Date() });
      return { ...v };
    },
    async replaceItems(_sql, versionId, items) {
      if (version(versionId).status !== "draft") throw dbError("42501");
      store.items = store.items.filter((i) => i.versionId !== versionId).concat(items.map((item) => ({ versionId, item })));
    },
    async linkOutcomes() {
      return undefined;
    },
    async transition(_sql, p) {
      store.calls.push(`transition:${p.action}`);
      const v = version(p.versionId);
      requireRole(p.actor, p.action === "submit" ? "editor" : "reviewer");
      const next: Record<string, [LessonStatus, LessonStatus]> = { submit: ["draft", "in_review"], approve: ["in_review", "approved"], reject: ["in_review", "draft"] };
      const pair = next[p.action];
      if (!pair) throw dbError("22023");
      const [from, to] = pair;
      if (v.status !== from) throw dbError("55000");
      if (p.action === "approve" && v.createdBy === p.actor) throw dbError("42501");
      v.status = to;
      if (p.action === "approve") v.reviewedBy = p.actor;
      return to;
    },
    async publish(_sql, p) {
      store.calls.push("publish");
      requireRole(p.actor, "publisher");
      const v = version(p.versionId);
      if (v.status !== "approved") throw dbError("55000");
      const lesson = store.lessons.find((l) => l.id === p.lessonId);
      if (!lesson) throw dbError("P0002");
      for (const old of store.publications.filter((x) => x.lessonId === p.lessonId && x.unpublishedAt === null)) {
        old.unpublishedAt = new Date();
        version(old.versionId).status = "archived";
      }
      v.status = "published";
      v.publishedAt = new Date();
      const revision = writeManifest(lesson.grade, null);
      store.publications.push({ id: randomUUID(), lessonId: p.lessonId, versionId: v.id, versionNo: v.versionNo, publishedBy: p.actor, publishedAt: v.publishedAt, reason: p.reason, manifestRevision: revision, unpublishedAt: null, unpublishedBy: null, unpublishReason: null });
      return { manifestRevision: revision, publishedAt: v.publishedAt };
    },
    async unpublish(_sql, p) {
      requireRole(p.actor, "publisher");
      const live = store.publications.find((x) => x.lessonId === p.lessonId && x.unpublishedAt === null);
      if (!live) throw dbError("55000");
      live.unpublishedAt = new Date();
      const lesson = store.lessons.find((l) => l.id === p.lessonId);
      if (!lesson) throw dbError("P0002");
      return { manifestRevision: writeManifest(lesson.grade, null), unpublishedAt: live.unpublishedAt };
    },
    async pin(_sql, p) {
      requireRole(p.actor, "publisher");
      const m = store.manifests.find((x) => x.revision === p.revision);
      if (!m) throw dbError("P0002");
      return { manifestRevision: writeManifest(m.grade, p.revision), pinnedFromRevision: p.revision };
    },
    async claimIdempotency(_sql, p) {
      const row = store.idempotency.find((r) => r.scope === p.scope && r.actor === p.actor && r.key === p.key);
      if (!row) {
        store.idempotency.push({ scope: p.scope, actor: p.actor, key: p.key, hash: p.requestSha256, status: null, body: null });
        return { kind: "new" };
      }
      if (row.hash !== p.requestSha256 || row.status === null) return { kind: "conflict" };
      return { kind: "replay", status: row.status, body: row.body };
    },
    async completeIdempotency(_sql, p) {
      const row = store.idempotency.find((r) => r.scope === p.scope && r.actor === p.actor && r.key === p.key);
      if (!row) throw new Error("idempotency row missing");
      row.status = p.status;
      row.body = p.body;
    },
  };
}
