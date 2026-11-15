import { handle } from "../../../../../../server/http";
import { exportHandler } from "../../../../../../server/privacy/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Owner/guardian: download every row of the household as JSON (attachment, no-store, audited). */
export const GET = (req: Request) => handle((c) => exportHandler(req, c));
