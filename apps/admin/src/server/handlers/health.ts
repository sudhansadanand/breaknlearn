import { json, type Ctx } from "../http";

export const SERVICE_VERSION = "0.1.0";

/** GET /api/v1/health — 200 only when configuration loaded (deps resolved). No DB, no secrets. */
export async function healthHandler(_req: Request, c: Ctx): Promise<Response> {
  return json(c, { status: "ok", version: SERVICE_VERSION });
}
