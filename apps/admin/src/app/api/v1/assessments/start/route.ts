import { startAssessmentHandler } from "../../../../../server/assessment/handlers";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PAIRED_DEVICE: start a baseline / immediate / delayed attempt (questions without answer keys). */
export const POST = (req: Request) => handle((c) => startAssessmentHandler(req, c));
