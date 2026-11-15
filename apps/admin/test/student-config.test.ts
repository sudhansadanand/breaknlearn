import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsForTesting } from "../src/server/deps";
import { makeTestEnv } from "./fakes";
import { studentConfig } from "../src/server/handlers/student-config";
import { GET } from "../src/app/api/v1/student/config/route";

describe("GET /api/v1/student/config", () => {
  beforeEach(() => setDepsForTesting(makeTestEnv().deps));
  afterEach(() => setDepsForTesting(null));

  it("defaults to live-equivalent local mode with the service worker on", () => {
    expect(studentConfig({})).toEqual({ paired_mode: false, telemetry: false, service_worker: true });
  });
  it("needs exact 'true' for paired mode, and telemetry only when paired", () => {
    expect(studentConfig({ FEATURE_STUDENT_PAIRED: "TRUE", FEATURE_TELEMETRY: "true" })).toEqual({ paired_mode: false, telemetry: false, service_worker: true });
    expect(studentConfig({ FEATURE_STUDENT_PAIRED: "true", FEATURE_TELEMETRY: "true" })).toEqual({ paired_mode: true, telemetry: true, service_worker: true });
  });
  it("FEATURE_STUDENT_SW=false is the service worker kill switch", () => {
    expect(studentConfig({ FEATURE_STUDENT_SW: "false" }).service_worker).toBe(false);
  });
  it("route responds 200 without any session", async () => {
    const res = await GET(new Request("http://localhost/api/v1/student/config"));
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(["paired_mode", "service_worker", "telemetry"]);
  });
});
