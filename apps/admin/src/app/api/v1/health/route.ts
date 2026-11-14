import { healthHandler } from "../../../../server/handlers/health";
import { handle } from "../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => healthHandler(req, c));
