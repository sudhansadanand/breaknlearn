import { meHandler } from "../../../../../server/handlers/admin";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => meHandler(req, c));
