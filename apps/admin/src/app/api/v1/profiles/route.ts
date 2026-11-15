import { listProfilesHandler, upsertProfileHandler } from "../../../../server/handlers/profiles";
import { handle } from "../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => listProfilesHandler(req, c));
export const POST = (req: Request) => handle((c) => upsertProfileHandler(req, c));
