import { z } from "zod";
import { Grade, IsoDateTime, Uuid } from "./common";
import { LessonContent, LessonStatus } from "./lesson";

/** Household roles and global content roles are separate (ADR-0003). */
export const HouseholdRole = z.enum(["owner", "guardian"]);
export const StaffRole = z.enum(["editor", "reviewer", "publisher", "analyst"]);
export type HouseholdRole = z.infer<typeof HouseholdRole>;
export type StaffRole = z.infer<typeof StaffRole>;

export const Me = z.object({
  user_id: Uuid,
  email: z.string().email(),
  households: z.array(z.object({ household_id: Uuid, role: HouseholdRole })),
  staff_roles: z.array(StaffRole),
});

export const Authority = z.enum(["editorial_unverified", "cisce_verified", "school_specific", "local_enrichment"]);
export const ReviewStatus = z.enum(["draft", "in_review", "verified", "archived"]);

export const CurriculumNode = z.object({
  id: Uuid,
  stable_key: z.string(),
  parent_id: Uuid.nullable(),
  grade: Grade,
  node_type: z.enum(["subject", "strand", "topic", "subtopic"]),
  title: z.string(),
  authority: Authority,
  review_status: ReviewStatus,
  source_ref: z.string().nullable(),
  sort_order: z.number().int(),
});

/** Verifying a node as CISCE requires a source document + page/section citation (CAT-006). */
export const CurriculumReviewRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({
    action: z.literal("verify"),
    source_document_id: Uuid,
    source_ref: z.string().min(1).max(200),
    authority: z.enum(["cisce_verified", "local_enrichment"]),
  }),
  z.object({ action: z.literal("archive"), reason: z.string().min(1).max(500) }),
]);

export const ImportJob = z.object({
  id: Uuid,
  status: z.enum(["queued", "extracting", "review", "failed", "approved"]),
  school_plan_id: Uuid,
  errors: z.array(z.object({ row: z.number().int().nullable(), code: z.string(), message: z.string() })),
  chapters: z.array(
    z.object({
      id: Uuid,
      chapter_number: z.string().nullable(),
      title: z.string(),
      page_start: z.number().int().nullable(),
      sort_order: z.number().int(),
      extraction_confidence: z.number().min(0).max(1).nullable(),
      suggestions: z.array(z.object({ curriculum_node_id: Uuid, confidence: z.number().min(0).max(1), state: z.enum(["suggested", "approved", "rejected"]) })),
    }),
  ),
});

export const MappingReviewRequest = z.object({
  decisions: z
    .array(z.object({ chapter_id: Uuid, curriculum_node_id: Uuid, decision: z.enum(["approve", "reject"]) }))
    .min(1)
    .max(500),
});

export const SaveDraftLessonRequest = z.object({ lesson_id: Uuid.optional(), content: LessonContent });
export const SaveDraftLessonResponse = z.object({
  lesson_id: Uuid,
  version_id: Uuid,
  version_no: z.number().int(),
  status: LessonStatus,
  validation_errors: z.array(z.object({ path: z.string(), message: z.string() })),
});

export const VersionTransitionRequest = z.object({
  action: z.enum(["submit", "approve", "reject"]),
  comment: z.string().max(1000).optional(),
});

export const PublishRequest = z.object({ version_id: Uuid, reason: z.string().min(1).max(500) });
export const PublishResponse = z.object({ manifest_revision: z.number().int().positive(), published_at: IsoDateTime });
