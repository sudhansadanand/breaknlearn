import { listLessonsHandler, saveDraftHandler } from "../../../../../server/content/lessons";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => listLessonsHandler(req, c));
export const POST = (req: Request) => handle((c) => saveDraftHandler(req, c));
