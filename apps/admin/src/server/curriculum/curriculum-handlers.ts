import { HttpError, type AdultIdentity } from "@bnl/auth";
import { CurriculumReviewRequest, Grade, ReviewStatus, StaffRole, SubjectKey } from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold, withStaff } from "../authn";
import type { Sql } from "../db-port";
import { json, readJson, validationFailed, type Ctx } from "../http";
import { db, enforceCurriculumRateLimit, pathUuid } from "./common";
import { getCurriculumDeps, type CurriculumDeps } from "./deps";
import type { NodeCursor, NodeRow } from "./types";

/** Display label of each authority (status chips in the explorer). */
export const AUTHORITY_LABEL = {
  editorial_unverified: "Editorial (unverified)",
  cisce_verified: "Verified CISCE",
  local_enrichment: "Local enrichment",
  school_specific: "School-specific",
} as const;

export const CurriculumQuery = z.object({
  grade: z.coerce.number().pipe(Grade).optional(),
  subject_key: SubjectKey.optional(),
  review_status: ReviewStatus.optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CurriculumQuery = z.infer<typeof CurriculumQuery>;

const CursorShape = z.tuple([z.number().int(), z.string().max(40), z.boolean(), z.number().int(), z.string().max(200)]);

export function encodeCursor(n: NodeRow): string {
  return Buffer.from(JSON.stringify([n.grade, n.subjectKey, n.nodeType !== "subject", n.sortOrder, n.stableKey])).toString("base64url");
}

export function decodeCursor(s: string): NodeCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(422, "validation_failed", "Invalid cursor");
    throw err;
  }
  const r = CursorShape.safeParse(raw);
  if (!r.success) throw new HttpError(422, "validation_failed", "Invalid cursor");
  const [grade, subjectKey, isTopic, sortOrder, stableKey] = r.data;
  return { grade, subjectKey, isTopic, sortOrder, stableKey };
}

/** API shape: the contract CurriculumNode plus subject, provenance and review metadata. */
export function toApiNode(n: NodeRow) {
  const prov = n.provenance;
  return {
    id: n.id,
    stable_key: n.stableKey,
    parent_id: n.parentId,
    grade: n.grade,
    subject_key: n.subjectKey,
    node_type: n.nodeType,
    title: n.title,
    authority: n.authority,
    authority_label: AUTHORITY_LABEL[n.authority],
    review_status: n.reviewStatus,
    source_ref: n.sourceRef,
    source_document_id: n.sourceDocumentId,
    sort_order: n.sortOrder,
    reviewed_at: n.reviewedAt ? n.reviewedAt.toISOString() : null,
    provenance: {
      origin: typeof prov.origin === "string" ? prov.origin : null,
      subject_authority: typeof prov.subject_authority === "string" ? prov.subject_authority : null,
      /** True for every seed/editorial node that no reviewer has verified against a cited source (CAT-006). */
      editorial_unverified: n.authority === "editorial_unverified",
    },
  };
}

export interface CurriculumView {
  readonly nodes: ReturnType<typeof toApiNode>[];
  readonly nextCursor: string | null;
  readonly staffRoles: readonly StaffRole[];
  /** Only for reviewers (to cite a source when verifying). */
  readonly sourceDocuments: readonly { id: string; title: string; versionLabel: string | null }[];
}

/**
 * Loads a page of nodes for any staff role (staff context), or for an owner/guardian of a household
 * (adult context, read-only browse). Anyone else gets 403.
 */
export async function loadCurriculum(c: Ctx, adult: AdultIdentity, q: CurriculumQuery, deps: CurriculumDeps = getCurriculumDeps()): Promise<CurriculumView> {
  const after = q.cursor ? decodeCursor(q.cursor) : undefined;
  const filter = {
    ...(q.grade !== undefined ? { grade: q.grade } : {}),
    ...(q.subject_key !== undefined ? { subjectKey: q.subject_key } : {}),
    ...(q.review_status !== undefined ? { reviewStatus: q.review_status } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(after ? { after } : {}),
    limit: q.limit + 1,
  };
  const staffRoles = await c.deps.db({ kind: "adult", userId: adult.userId }, (sql) => c.deps.repos.memberships.activeStaffRoles(sql, adult.userId));
  const [rows, sourceDocuments] =
    staffRoles.length > 0
      ? await withStaff(c, adult, StaffRole.options, async (sql, held) => [await deps.repo.listNodes(sql, filter), held.includes("reviewer") ? await deps.repo.listSourceDocuments(sql) : []] as const)
      : [await withAdultHousehold(c, adult, (sql: Sql) => deps.repo.listNodes(sql, filter)), []];
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return { nodes: page.map(toApiNode), nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null, staffRoles, sourceDocuments };
}

/** GET /api/v1/admin/curriculum */
export async function listCurriculumHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = CurriculumQuery.safeParse(params);
  if (!parsed.success) throw validationFailed(parsed.error.issues, "Query is invalid");
  const view = await loadCurriculum(c, adult, parsed.data);
  return json(c, {
    nodes: view.nodes,
    next_cursor: view.nextCursor,
    viewer: { staff_roles: view.staffRoles, can_review: view.staffRoles.includes("reviewer"), can_submit: view.staffRoles.some((r) => r === "editor" || r === "reviewer") },
  });
}

/** POST /api/v1/admin/curriculum/{nodeId}/review — submit (editor|reviewer), verify/archive (reviewer). */
export async function reviewCurriculumHandler(req: Request, c: Ctx, rawNodeId: string, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const nodeId = pathUuid(rawNodeId);
  const body = await readJson(req, CurriculumReviewRequest);
  await enforceCurriculumRateLimit(c, "curriculumReviewByUser", adult.userId);
  const roles: StaffRole[] = body.action === "submit" ? ["editor", "reviewer"] : ["reviewer"];
  const now = c.deps.now();
  const node = await withStaff(c, adult, roles, async (sql) => {
    const current = await deps.repo.getNodeForUpdate(sql, nodeId);
    if (!current) throw new HttpError(404, "not_found", "Not found");
    if (current.nodeType === "subject" && body.action !== "archive" && current.authority === "local_enrichment") {
      // Enrichment subjects are family subjects; they are never put through CISCE review.
      throw new HttpError(409, "conflict", "Enrichment subject nodes are not reviewed against CISCE");
    }
    let updated: NodeRow;
    let metadata: Record<string, unknown>;
    switch (body.action) {
      case "submit": {
        if (current.reviewStatus !== "draft") throw new HttpError(409, "conflict", "Only draft nodes can be submitted for review");
        updated = await db(deps.repo.updateNodeReview(sql, { id: nodeId, reviewStatus: "in_review" }));
        metadata = { from: current.reviewStatus, to: "in_review" };
        await c.deps.repos.audit.insert(sql, { actorAuthId: adult.userId, householdId: null, action: "curriculum.node_submitted", targetType: "curriculum_node", targetId: nodeId, metadata });
        break;
      }
      case "verify": {
        if (current.reviewStatus !== "in_review") throw new HttpError(409, "conflict", "Submit the node for review before verifying it");
        const editor = (await deps.repo.lastSubmitter(sql, nodeId)) ?? current.createdBy;
        if (editor !== null && editor === adult.userId) throw new HttpError(403, "forbidden", "A reviewer cannot verify their own submission");
        if (!(await deps.repo.sourceDocumentExists(sql, body.source_document_id))) {
          throw new HttpError(422, "validation_failed", "Source document not found", { issues: [{ path: "source_document_id", code: "not_found" }] });
        }
        if (body.authority === "cisce_verified" && (await deps.repo.subjectAuthority(sql, current.grade, current.subjectKey)) !== "cisce") {
          throw new HttpError(422, "validation_failed", "Enrichment subjects cannot be marked CISCE-verified", { issues: [{ path: "authority", code: "not_cisce_subject" }] });
        }
        updated = await db(
          deps.repo.updateNodeReview(sql, {
            id: nodeId,
            reviewStatus: "verified",
            authority: body.authority,
            sourceDocumentId: body.source_document_id,
            sourceRef: body.source_ref.trim(),
            reviewedBy: adult.userId,
            reviewedAt: now,
          }),
        );
        metadata = { from: current.reviewStatus, to: "verified", authority: body.authority, source_document_id: body.source_document_id, source_ref: body.source_ref.trim(), previous_authority: current.authority };
        await c.deps.repos.audit.insert(sql, { actorAuthId: adult.userId, householdId: null, action: "curriculum.node_verified", targetType: "curriculum_node", targetId: nodeId, metadata });
        break;
      }
      case "archive": {
        if (current.reviewStatus === "archived") throw new HttpError(409, "conflict", "Already archived");
        updated = await db(
          deps.repo.updateNodeReview(sql, {
            id: nodeId,
            reviewStatus: "archived",
            reviewedBy: adult.userId,
            reviewedAt: now,
            provenancePatch: { archive_reason: body.reason.trim(), archived_at: now.toISOString() },
          }),
        );
        // The free-text reason lives on the node (provenance), never in audit metadata.
        metadata = { from: current.reviewStatus, to: "archived", reason_chars: body.reason.trim().length };
        await c.deps.repos.audit.insert(sql, { actorAuthId: adult.userId, householdId: null, action: "curriculum.node_archived", targetType: "curriculum_node", targetId: nodeId, metadata });
        break;
      }
    }
    return updated;
  });
  return json(c, { node: toApiNode(node) });
}
