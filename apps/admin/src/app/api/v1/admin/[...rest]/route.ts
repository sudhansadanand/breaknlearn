import { notImplementedAdminHandler } from "../../../../../server/handlers/admin";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Catch-all for /api/v1/admin/* endpoints owned by later milestones: unauthenticated
 * callers always get 401 (SEC-001); authenticated callers get 404 until implemented.
 */
const h = (req: Request) => handle((c) => notImplementedAdminHandler(req, c));
export const GET = h;
export const POST = h;
export const PUT = h;
export const PATCH = h;
export const DELETE = h;
