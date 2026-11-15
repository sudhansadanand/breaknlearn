import { finishAssessmentHandler } from "../../../../../../server/assessment/handlers";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PAIRED_DEVICE: close the attempt; totals come from server-scored responses; schedules the next review. */
export const POST = (req: Request, ctx: { params: Promise<{ attemptId: string }> }) =>
  handle(async (c) => finishAssessmentHandler(req, c, (await ctx.params).attemptId));
