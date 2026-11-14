import { consentHandler } from "../../../../../server/handlers/admin";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handle((c) => consentHandler(req, c));
