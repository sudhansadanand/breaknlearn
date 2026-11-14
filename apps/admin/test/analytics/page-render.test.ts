/** Server-renders /admin/analytics with fakes: session gate, household data only, accessible evidence wording. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MULTIPLICATION_LESSON_IDS } from "@bnl/contracts";
import { setAnalyticsRepoForTesting } from "../../src/server/analytics";
import { setDepsForTesting } from "../../src/server/deps";
import { HH_A, HH_B, OWNER_A, makeTestEnv, type TestEnv } from "../fakes";
import { emptyAnalyticsStore, fakeAnalyticsRepo } from "./fake-repo";

let env: TestEnv;
let cookie: string | undefined;

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (cookie === undefined ? undefined : { value: cookie }) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));

beforeEach(() => {
  env = makeTestEnv();
  setDepsForTesting(env.deps);
  const as = emptyAnalyticsStore();
  as.recommendations.push({
    id: "e1000000-0000-4000-8000-0000000000a1", householdId: HH_A, learnerId: "c1000000-0000-4000-8000-0000000000a1", topicId: null,
    lessonId: MULTIPLICATION_LESSON_IDS[2]!, reasonCode: "mastery_low_prerequisite_practice", suggestedLessonId: MULTIPLICATION_LESSON_IDS[2]!,
    computedAt: new Date("2026-11-13T00:00:00Z"), dismissedAt: null, detail: {}, supersededAt: null,
  });
  setAnalyticsRepoForTesting(fakeAnalyticsRepo(env.store, as));
  env.store.profiles.push(
    { id: "c1000000-0000-4000-8000-0000000000a1", householdId: HH_A, slot: 1, displayName: "Asha", grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now },
    { id: "c1000000-0000-4000-8000-0000000000b1", householdId: HH_B, slot: 1, displayName: "Other", grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now },
  );
});
afterEach(() => {
  setDepsForTesting(null);
  setAnalyticsRepoForTesting(null);
});

async function render(): Promise<string> {
  // vitest compiles TSX with the classic runtime (the app's tsconfig uses jsx: preserve for Next).
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: Page } = await import("../../src/app/admin/(portal)/analytics/page");
  return renderToStaticMarkup(await Page());
}

describe("/admin/analytics page", () => {
  it("redirects to login without a valid session", async () => {
    cookie = undefined;
    await expect(render()).rejects.toThrow("REDIRECT:/admin/login");
    cookie = "forged";
    await expect(render()).rejects.toThrow("REDIRECT:/admin/login");
  });

  it("renders only the caller's children, with evidence wording instead of zeros", async () => {
    cookie = env.auth.sessionFor(OWNER_A);
    const html = await render();
    expect(html).toContain("Asha");
    expect(html).not.toContain("Other");
    expect(html).toContain("<caption>Multiplication tables ×1–×10 for Asha</caption>");
    expect(html).toContain('<th scope="col">Later review (memory)</th>');
    expect(html).toContain("Not started yet");
    expect(html).not.toMatch(/>0%</);
    expect(html).toContain("not part of any score");
    expect(html).toContain("Watch ×2 table again with the picture groups");
    expect(html).toContain('aria-label="Dismiss suggestion: Watch ×2 table again with the picture groups"');
    expect(html).toContain("Scores have not been calculated yet");
  });
});
