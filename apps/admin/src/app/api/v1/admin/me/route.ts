import { meHandler } from "../../../../../server/handlers/admin";
import { withPasswordChangeFlag } from "../../../../../server/handlers/session";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => withPasswordChangeFlag(req, c, meHandler));
