import { handle } from "../../../../../server/http";
import { progressSyncHandler } from "../../../../../server/learning/progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handle((c) => progressSyncHandler(req, c));
