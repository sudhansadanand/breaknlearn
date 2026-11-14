import { HttpError, REQUEST_ID_HEADER } from "@bnl/auth";
import { Grade, PublishedLesson, PublishedManifest, Uuid } from "@bnl/contracts";
import type { Ctx } from "../http";
import { json } from "../http";
import { contentRepo } from "./port";
import { requireFeature } from "../flags";

/** ADR-0006: catalog responses are CDN-cacheable; private responses never are. */
export const CATALOG_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=600";

const etagOf = (checksum: string) => `"${checksum}"`;

/** RFC 9110 If-None-Match (weak comparison): `*` or any listed tag equal to ours. */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const t = raw.trim();
    return t === "*" || t.replace(/^W\//, "") === etag;
  });
}

function catalogResponse(c: Ctx, req: Request, body: unknown, checksum: string): Response {
  const etag = etagOf(checksum);
  const headers = { "cache-control": CATALOG_CACHE_CONTROL, etag, vary: "Accept-Encoding" };
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ...headers, [REQUEST_ID_HEADER]: c.requestId } });
  }
  return json(c, body, 200, headers);
}

const notFound = () => new HttpError(404, "not_found", "Not found");

/** GET /api/v1/catalog/manifest?grade=2|6 — PUBLIC_PUBLISHED, `{kind:'public'}` only (SEC-006). */
export async function catalogManifestHandler(req: Request, c: Ctx): Promise<Response> {
  requireFeature("FEATURE_CATALOG_API", "Catalog API");
  const raw = new URL(req.url).searchParams.get("grade");
  const grade = Grade.safeParse(raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN);
  if (!grade.success) throw new HttpError(422, "validation_failed", "grade must be 2 or 6", { issues: [{ path: "grade", code: "invalid_literal" }] });

  const found = await c.deps.db({ kind: "public" }, async (sql) => {
    const repo = contentRepo();
    const row = await repo.latestManifest(sql, grade.data);
    if (!row) return null;
    const parsed = PublishedManifest.safeParse(row.manifest);
    // Fail closed: a manifest that does not match the contract or its own row is never served.
    if (!parsed.success || parsed.data.checksum !== row.checksum || parsed.data.revision !== row.revision || parsed.data.grade !== grade.data) {
      throw new Error("published manifest failed contract validation");
    }
    // Defence in depth (SEC-006): every listed version must be live, i.e. visible to bnl_public.
    const versionIds = [...new Set(parsed.data.subjects.flatMap((s) => s.topics.flatMap((t) => t.lessons.map((l) => l.version_id))))];
    if ((await repo.countVisibleVersions(sql, versionIds)) !== versionIds.length) {
      throw new Error("published manifest lists a version that is not live");
    }
    return parsed.data;
  });
  if (!found) throw notFound();
  return catalogResponse(c, req, found, found.checksum);
}

/** GET /api/v1/catalog/lessons/{lessonId} — the live version only; no answer keys; 404 otherwise. */
export async function catalogLessonHandler(req: Request, c: Ctx, lessonIdParam: string): Promise<Response> {
  requireFeature("FEATURE_CATALOG_API", "Catalog API");
  const id = Uuid.safeParse(lessonIdParam);
  // Malformed, unknown, draft-only and unpublished ids are indistinguishable (no existence oracle).
  if (!id.success) throw notFound();
  const lesson = await c.deps.db({ kind: "public" }, async (sql) => {
    const row = await contentRepo().publishedLesson(sql, id.data);
    if (!row) return null;
    const parsed = PublishedLesson.safeParse({
      id: row.id,
      version_id: row.versionId,
      version_no: row.versionNo,
      checksum: row.checksum,
      published_at: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
      content: row.content,
    });
    if (!parsed.success) throw new Error("published lesson failed contract validation");
    return parsed.data;
  });
  if (!lesson) throw notFound();
  return catalogResponse(c, req, lesson, lesson.checksum);
}
