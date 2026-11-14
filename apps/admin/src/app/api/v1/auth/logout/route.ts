import { logoutHandler } from "../../../../../server/handlers/session";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handle((c) => logoutHandler(req, c));
