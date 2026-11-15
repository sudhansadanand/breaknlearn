import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Validator } from "@seriousme/openapi-schema-validator";
import * as C from "../src/index";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const openapi = parseYaml(readFileSync(here("../openapi/openapi.yaml"), "utf8"));
const eventSchema = JSON.parse(readFileSync(here("../schemas/learning-event-v1.schema.json"), "utf8"));
const validEvent = JSON.parse(readFileSync(here("../fixtures/valid-event.json"), "utf8"));

function ajvForOpenapi() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const applyFormats = (addFormats as unknown as { default?: (a: Ajv2020) => void }).default ?? (addFormats as unknown as (a: Ajv2020) => void);
  applyFormats(ajv);
  ajv.addSchema(eventSchema);
  ajv.addSchema({ $id: "openapi", components: openapi.components });
  return ajv;
}
const component = (ajv: Ajv2020, name: string) => {
  const v = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (!v) throw new Error(`missing component ${name}`);
  return v;
};

describe("OpenAPI 3.1 document", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const validator = new Validator();
    const res = await validator.validate(openapi);
    expect(res.errors ?? []).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("has unique operationIds and every path under the v1 root conventions", () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries<Record<string, { operationId?: string }>>(openapi.paths)) {
      expect(path.startsWith("/")).toBe(true);
      for (const op of Object.values(item)) if (op.operationId) ids.push(op.operationId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requires Idempotency-Key on telemetry, progress sync, legacy import, publish and import", () => {
    const needs = [
      ["/telemetry/batch", "post"],
      ["/progress/sync", "post"],
      ["/progress/legacy-import", "post"],
      ["/admin/lessons/{lessonId}/publish", "post"],
      ["/admin/imports", "post"],
    ] as const;
    for (const [p, m] of needs) {
      const params = JSON.stringify(openapi.paths[p][m].parameters ?? []);
      expect(params, p).toContain("#/components/parameters/IdempotencyKey");
    }
  });

  it("protects every /admin path with AdultSession", () => {
    for (const [path, item] of Object.entries<Record<string, { security?: unknown }>>(openapi.paths)) {
      if (!path.startsWith("/admin")) continue;
      for (const op of Object.values(item)) expect(JSON.stringify(op.security), path).toContain("AdultSession");
    }
  });

  it("only exposes health, pairing bootstrap and the published catalog without credentials", () => {
    const publicOps: string[] = [];
    for (const [path, item] of Object.entries<Record<string, { security?: unknown[] }>>(openapi.paths)) {
      for (const op of Object.values(item)) if (!op.security || op.security.length === 0) publicOps.push(path);
    }
    expect(publicOps.sort()).toEqual(
      ["/catalog/lessons/{lessonId}", "/catalog/manifest", "/devices/pairing-code", "/devices/token", "/devices/token/refresh", "/health"].sort(),
    );
  });
});

describe("telemetry event: JSON Schema and Zod agree", () => {
  const ajv = ajvForOpenapi();
  const jsonValidate = ajv.getSchema(eventSchema.$id)!;
  const cases: [string, unknown, boolean][] = [
    ["valid", validEvent, true],
    ["extra top-level field", { ...validEvent, child_name: "x" }, false],
    ["client-claimed correctness", { ...validEvent, payload: { ...validEvent.payload, is_correct: true } }, false],
    ["heartbeat over 30s cap", { ...validEvent, payload: { ...validEvent.payload, visible_ms: 30001 } }, false],
    ["non-uuid learner", { ...validEvent, learner_id: "child-1" }, false],
    ["unknown event type", { ...validEvent, event_type: "screen_recorded" }, false],
    ["schema_version 2", { ...validEvent, schema_version: 2 }, false],
    ["free-text reason", { ...validEvent, payload: { reason_code: "Hello World" } }, false],
    ["unknown theme", { ...validEvent, payload: { theme_key: "space" } }, false],
  ];
  for (const [name, input, ok] of cases) {
    it(`${name} -> ${ok ? "accepted" : "rejected"} by both`, () => {
      expect(jsonValidate(input)).toBe(ok);
      expect(C.LearningEvent.safeParse(input).success).toBe(ok);
    });
  }

  it("event type enum identical in Zod, JSON Schema and handoff spec §7", () => {
    expect([...C.EventType.options]).toEqual(eventSchema.properties.event_type.enum);
  });

  it("OpenAPI LearningEvent component is identical to the JSON Schema file", () => {
    const { $schema: _s, $id: _i, title: _t, ...fileBody } = eventSchema;
    const { description: _d, ...inlined } = openapi.components.schemas.LearningEvent;
    expect(inlined).toEqual(fileBody);
    const v = component(ajv, "LearningEvent");
    expect(v(validEvent)).toBe(true);
    expect(v({ ...validEvent, extra: 1 })).toBe(false);
  });
});

describe("OpenAPI components agree with Zod on fixtures", () => {
  const ajv = ajvForOpenapi();
  const lessonId = C.MULTIPLICATION_LESSON_IDS[3]!;
  const fixtures: Record<string, [unknown, keyof typeof C][]> = {
    Profile: [[{ id: "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22", slot: 1, display_name: "Asha", grade: 2, avatar_id: "fox" }, "Profile"]],
    ProgressSyncRequest: [[
      { learner_id: "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22", lesson_id: lessonId, theme_key: "candy", attempt_id: "8c1f0a77-1d2e-4c55-8f3e-6a2b9d0c4e21", client_revision: 3, base_server_revision: null, slide_id: "step-4", position_seconds: 3.2, completed: false, client_updated_at: "2026-11-14T09:00:00Z" },
      "ProgressSyncRequest",
    ]],
    LearningScore: [[
      { learner_id: "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22", topic_id: null, score: null, status: "insufficient_evidence", confidence: "low", components: { M: null, R: null, I: null, C: 100 }, coverage_pct: 10, weights_version: "els-v1", questions_count: 0, confidence_note: "No quiz answers yet", limitation: "Completion only", computed_at: "2026-11-14T09:00:00Z" },
      "LearningScore",
    ]],
  };
  for (const [name, list] of Object.entries(fixtures)) {
    for (const [value, zodName] of list) {
      it(`${name} fixture valid in both`, () => {
        const v = component(ajv, name);
        expect(v(value), JSON.stringify(v.errors)).toBe(true);
        const schema = C[zodName] as unknown as { safeParse: (x: unknown) => { success: boolean } };
        expect(schema.safeParse(value).success).toBe(true);
      });
    }
  }

  it("Profile rejects markup in display_name in both", () => {
    const bad = { id: "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22", slot: 1, display_name: "<img onerror=x>", grade: 2, avatar_id: "fox" };
    expect(component(ajv, "Profile")(bad)).toBe(false);
    expect(C.Profile.safeParse(bad).success).toBe(false);
  });

  it("enums in OpenAPI match Zod", () => {
    const s = openapi.components.schemas;
    expect(s.SubjectKey.enum).toEqual([...C.SubjectKey.options]);
    expect(s.ThemeKey.enum).toEqual([...C.ThemeKey.options]);
    expect(s.AvatarId.enum).toEqual([...C.AvatarId.options]);
    expect(s.LessonStatus.enum).toEqual([...C.LessonStatus.options]);
    expect(s.TemplateKey.enum).toEqual([...C.TemplateKey.options]);
    expect(s.Error.properties.error.properties.code.enum).toEqual([...C.ErrorCode.options]);
  });
});

describe("canonical catalog matches the live app snapshot", () => {
  const live = readFileSync(here("../../../legacy/live-snapshot-2026-11-14/index.html"), "utf8");
  it("CAT-001/CAT-002 subject arrays identical to live code, in order", () => {
    const m = /var subjects=(\{2:\[.*?\]\],6:\[.*?\]\]\});/s.exec(live);
    expect(m).not.toBeNull();
    const liveSubjects = new Function(`return ${m![1]}`)() as Record<string, [string, string][]>;
    for (const g of [2, 6] as const) {
      expect(C.GRADE_SUBJECTS[g].map((s) => [s.label, s.icon])).toEqual(liveSubjects[g]);
    }
  });
  it("six worlds identical to live code, in order", () => {
    const m = /var worlds=(\[.*?\]);/s.exec(live);
    const liveWorlds = new Function(`return ${m![1]}`)() as { id: string; name: string; icon: string; plural: string; color: string }[];
    expect(C.WORLDS.map((w) => ({ id: w.key, name: w.name, icon: w.icon, plural: w.plural, color: w.color }))).toEqual(liveWorlds);
  });
  it("avatar emoji list identical to live code, in order", () => {
    const m = /var avatars=(\[.*?\]);/s.exec(live);
    const liveAvatars = new Function(`return ${m![1]}`)() as string[];
    expect(C.AVATARS.map((a) => a.emoji)).toEqual(liveAvatars);
  });
  it("10 initial published lessons with distinct fixed ids", () => {
    expect(C.INITIAL_PUBLISHED_LESSON_KEYS).toHaveLength(10);
    expect(new Set(Object.values(C.MULTIPLICATION_LESSON_IDS)).size).toBe(10);
  });
});

describe("legacy storage parsing", () => {
  const fx = JSON.parse(readFileSync(here("../../../tests/fixtures/legacy/profiles-v1-two-children.json"), "utf8"));
  it("parses the live profile root and both profiles", () => {
    const root = C.LegacyProfilesRoot.parse(fx[C.LEGACY_PROFILES_KEY]);
    const profiles = root.profiles.map((p) => C.LegacyProfile.parse(p));
    expect(profiles.map((p) => p.id)).toEqual(["child-1", "child-2"]);
    expect(C.avatarIdFromEmoji(profiles[1]!.avatar)).toBe("astronaut");
  });
  it("maps keys: times-N:world -> N; bare world -> 3 only (MIG-003)", () => {
    expect(C.parseLegacyLessonKey("times-1:puppy", {})).toEqual({ table: 1, world: "puppy" });
    expect(C.parseLegacyLessonKey("times-10:farm", {})).toEqual({ table: 10, world: "farm" });
    expect(C.parseLegacyLessonKey("farm", { table: 7 })).toEqual({ table: 3, world: "farm" });
    expect(C.parseLegacyLessonKey("times-11:farm", {})).toBeNull();
    expect(C.parseLegacyLessonKey("../etc", {})).toBeNull();
  });
  it("slide number parsing matches live number()", () => {
    expect(C.legacySlideNumber({ slideId: "step-4" })).toBe(4);
    expect(C.legacySlideNumber({ slideId: "three-6" })).toBe(6);
    expect(C.legacySlideNumber({ slideId: "step-0" })).toBe(1);
    expect(C.legacySlideNumber({})).toBe(1);
    expect(C.legacySlideNumber(null)).toBe(1);
  });
});
