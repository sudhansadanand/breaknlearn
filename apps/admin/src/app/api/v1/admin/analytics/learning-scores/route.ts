import { learningScoresHandler } from "../../../../../../server/analytics";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => learningScoresHandler(req, c));
