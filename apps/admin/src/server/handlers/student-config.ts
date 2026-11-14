import { json, type Ctx } from "../http";

export interface StudentConfig {
  paired_mode: boolean;
  telemetry: boolean;
  service_worker: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * Runtime switches for the student TV bundle (A5 proposal §1.4). Fail-safe defaults: paired mode and
 * telemetry are off unless explicitly "true"; the service worker stays on unless explicitly "false",
 * which is also its fleet-wide kill switch.
 */
export function studentConfig(env: Env): StudentConfig {
  const paired = env.FEATURE_STUDENT_PAIRED === "true";
  return {
    paired_mode: paired,
    telemetry: paired && env.FEATURE_TELEMETRY === "true",
    service_worker: env.FEATURE_STUDENT_SW !== "false",
  };
}

/** GET /api/v1/student/config: public, no auth, no child data, Cache-Control no-store (middleware). */
export async function studentConfigHandler(_req: Request, c: Ctx, env: Env = process.env): Promise<Response> {
  return json(c, studentConfig(env));
}
