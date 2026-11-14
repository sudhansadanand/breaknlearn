import { listCurriculumHandler } from "../../../../../server/curriculum/curriculum-handlers";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => listCurriculumHandler(req, c));
