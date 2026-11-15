import * as catalogLesson from "../../src/app/api/v1/catalog/lessons/[lessonId]/route";
import * as catalogManifest from "../../src/app/api/v1/catalog/manifest/route";
import * as lessonDetail from "../../src/app/api/v1/admin/lessons/[lessonId]/route";
import * as publish from "../../src/app/api/v1/admin/lessons/[lessonId]/publish/route";
import * as unpublish from "../../src/app/api/v1/admin/lessons/[lessonId]/unpublish/route";
import * as preview from "../../src/app/api/v1/admin/lessons/[lessonId]/versions/[versionId]/preview/route";
import * as transition from "../../src/app/api/v1/admin/lessons/[lessonId]/versions/[versionId]/transition/route";
import * as lessons from "../../src/app/api/v1/admin/lessons/route";
import * as pin from "../../src/app/api/v1/admin/manifests/[revision]/pin/route";
import { ORIGIN, req, type ReqOpts } from "../fakes";

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export const STAFF = {
  editor: { userId: "e0000000-0000-4000-8000-0000000000e1", email: "editor@bnl.test" },
  reviewer: { userId: "e0000000-0000-4000-8000-0000000000e2", email: "reviewer@bnl.test" },
  publisher: { userId: "e0000000-0000-4000-8000-0000000000e3", email: "publisher@bnl.test" },
  analyst: { userId: "e0000000-0000-4000-8000-0000000000e4", email: "analyst@bnl.test" },
  editorReviewer: { userId: "e0000000-0000-4000-8000-0000000000e5", email: "editor-reviewer@bnl.test" },
} as const;

let keySeq = 0;
export const newKey = () => `test-key-${Date.now()}-${++keySeq}`;

/** Thin wrappers around the content route modules (same objects Next serves). */
export const api = {
  manifest: (grade: string | number, headers: Record<string, string> = {}) => {
    const r = req("GET", `/api/v1/catalog/manifest?grade=${grade}`, { csrf: false });
    for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
    return catalogManifest.GET(r);
  },
  catalogLesson: (lessonId: string, headers: Record<string, string> = {}) => {
    const r = req("GET", `/api/v1/catalog/lessons/${lessonId}`, { csrf: false });
    for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
    return catalogLesson.GET(r, params({ lessonId }));
  },
  list: (o: ReqOpts & { query?: string } = {}) => lessons.GET(req("GET", `/api/v1/admin/lessons${o.query ?? ""}`, o)),
  save: (body: unknown, o: ReqOpts = {}) => lessons.POST(req("POST", "/api/v1/admin/lessons", { body, ...o })),
  detail: (lessonId: string, o: ReqOpts = {}) => lessonDetail.GET(req("GET", `/api/v1/admin/lessons/${lessonId}`, o), params({ lessonId })),
  preview: (lessonId: string, versionId: string, o: ReqOpts = {}) =>
    preview.GET(req("GET", `/api/v1/admin/lessons/${lessonId}/versions/${versionId}/preview`, o), params({ lessonId, versionId })),
  transition: (lessonId: string, versionId: string, body: unknown, o: ReqOpts = {}) =>
    transition.POST(req("POST", `/api/v1/admin/lessons/${lessonId}/versions/${versionId}/transition`, { body, ...o }), params({ lessonId, versionId })),
  publish: (lessonId: string, body: unknown, key: string | null, o: ReqOpts = {}) => {
    const r = req("POST", `/api/v1/admin/lessons/${lessonId}/publish`, { body, ...o });
    if (key !== null) r.headers.set("Idempotency-Key", key);
    return publish.POST(r, params({ lessonId }));
  },
  unpublish: (lessonId: string, body: unknown, key: string | null, o: ReqOpts = {}) => {
    const r = req("POST", `/api/v1/admin/lessons/${lessonId}/unpublish`, { body, ...o });
    if (key !== null) r.headers.set("Idempotency-Key", key);
    return unpublish.POST(r, params({ lessonId }));
  },
  pin: (revision: number | string, key: string | null, o: ReqOpts = {}) => {
    const r = req("POST", `/api/v1/admin/manifests/${revision}/pin`, o);
    if (key !== null) r.headers.set("Idempotency-Key", key);
    return pin.POST(r, params({ revision: String(revision) }));
  },
};

export const TOPIC_KEY = "grade2.math.multiplication";

export function pictureContent(stableKey: string, factor: number, over: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) {
  return {
    contract_version: 1, stable_key: stableKey, grade: 2, subject_key: "math", topic_key: TOPIC_KEY,
    title: `${factor} Times Table`, template: "picture_groups_v1",
    config: { factor, count_from: 1, count_to: 10, themes: ["puppy", "candy", "unicorn", "school", "treat", "farm"], seconds_per_slide: 7, quiz_question_count: 3, ...cfg },
    learning_outcome_keys: [TOPIC_KEY], rights: { type: "original_generated_content", reviewed: true },
    ...over,
  };
}

export { ORIGIN };
