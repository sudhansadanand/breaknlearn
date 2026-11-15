import { handle } from "../../../../server/http";
import { listProgressHandler } from "../../../../server/learning/progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => listProgressHandler(req, c));
