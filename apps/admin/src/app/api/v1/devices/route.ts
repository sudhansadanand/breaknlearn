import { listDevicesHandler } from "../../../../server/handlers/devices";
import { handle } from "../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => listDevicesHandler(req, c));
