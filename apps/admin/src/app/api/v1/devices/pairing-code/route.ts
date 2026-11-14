import { createPairingCodeHandler } from "../../../../../server/handlers/pairing";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handle((c) => createPairingCodeHandler(req, c));
