import { handle } from "../../../../../server/http";
import { studentConfigHandler } from "../../../../../server/handlers/student-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => studentConfigHandler(req, c));
