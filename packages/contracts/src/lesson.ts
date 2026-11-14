import { z } from "zod";
import { Grade, IsoDateTime, Uuid } from "./common";
import { SubjectKey, ThemeKey } from "./catalog";

export const LessonStatus = z.enum(["draft", "in_review", "approved", "published", "archived"]);
export type LessonStatus = z.infer<typeof LessonStatus>;

export const TemplateKey = z.enum([
  "picture_groups_v1",
  "slides_v1",
  "video_v1",
  "audio_v1",
  "story_v1",
  "quiz_v1",
]);
export type TemplateKey = z.infer<typeof TemplateKey>;

/** Config for the multiplication picture-groups template (one lesson per table; worlds are themes). */
export const PictureGroupsConfig = z.object({
  factor: z.number().int().min(1).max(10),
  count_from: z.number().int().min(1).max(10).default(1),
  count_to: z.number().int().min(1).max(10).default(10),
  themes: z.array(ThemeKey).min(1).max(6),
  seconds_per_slide: z.number().int().min(3).max(30).default(7),
  quiz_question_count: z.number().int().min(1).max(10).default(3),
});
export type PictureGroupsConfig = z.infer<typeof PictureGroupsConfig>;

export const QuizOption = z.object({ id: z.string().min(1).max(64), label: z.string().max(200) });

/** Item bank entry. `correct_option_id` is SERVER-ONLY and must never appear in catalog responses. */
export const QuizItem = z.object({
  question_version_key: z.string().min(1).max(128),
  outcome_key: z.string().max(128),
  stage_eligibility: z.array(z.enum(["baseline", "immediate", "delayed"])).min(1),
  prompt: z.string().max(500),
  options: z.array(QuizOption).min(2).max(6),
  correct_option_id: z.string().min(1).max(64),
});

export const Rights = z.object({
  type: z.enum(["original_generated_content", "licensed", "public_domain", "owner_supplied"]),
  reviewed: z.boolean(),
  attribution: z.string().max(500).optional(),
});

/** Immutable content of one lesson version (stored in lesson_versions.content). */
export const LessonContent = z.object({
  contract_version: z.literal(1),
  stable_key: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/),
  grade: Grade,
  subject_key: SubjectKey,
  topic_key: z.string().max(128),
  title: z.string().min(1).max(120),
  template: TemplateKey,
  config: z.record(z.unknown()),
  learning_outcome_keys: z.array(z.string().max(128)).min(1),
  rights: Rights,
});
export type LessonContent = z.infer<typeof LessonContent>;

export const LessonSummary = z.object({
  id: Uuid,
  version_id: Uuid,
  version_no: z.number().int().positive(),
  stable_key: z.string(),
  grade: Grade,
  subject_key: SubjectKey,
  topic_id: Uuid.nullable(),
  title: z.string(),
  template_key: TemplateKey,
  sort_order: z.number().int(),
});
export type LessonSummary = z.infer<typeof LessonSummary>;

export const PublishedManifest = z.object({
  revision: z.number().int().positive(),
  checksum: z.string(),
  grade: Grade,
  generated_at: IsoDateTime,
  subjects: z.array(
    z.object({
      key: SubjectKey,
      label: z.string(),
      playable: z.boolean(),
      topics: z.array(
        z.object({ id: Uuid, key: z.string(), title: z.string(), lessons: z.array(LessonSummary) }),
      ),
    }),
  ),
});
export type PublishedManifest = z.infer<typeof PublishedManifest>;

/** Public published lesson: content without answer keys. */
export const PublishedLesson = z.object({
  id: Uuid,
  version_id: Uuid,
  version_no: z.number().int().positive(),
  checksum: z.string(),
  published_at: IsoDateTime,
  content: LessonContent,
});
export type PublishedLesson = z.infer<typeof PublishedLesson>;
