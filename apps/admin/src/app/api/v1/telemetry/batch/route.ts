import { handle } from "../../../../../server/http";
import { telemetryBatchHandler } from "../../../../../server/learning/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handle((c) => telemetryBatchHandler(req, c));
