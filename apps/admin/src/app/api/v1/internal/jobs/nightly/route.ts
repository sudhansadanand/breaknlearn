import { handle } from "../../../../../../server/http";
import { jobsCronHandler } from "../../../../../../server/handlers/jobs-cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = (req: Request) => handle((c) => jobsCronHandler(req, c));
