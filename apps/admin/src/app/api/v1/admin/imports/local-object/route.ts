import { localObjectHandler } from "../../../../../../server/curriculum/import-handlers";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => localObjectHandler(req, c));
