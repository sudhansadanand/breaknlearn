import { submitAnswerHandler } from "../../../../../../server/assessment/handlers";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PAIRED_DEVICE: one answer (selected_option_id only); scored server-side. */
export const POST = (req: Request, ctx: { params: Promise<{ attemptId: string }> }) =>
  handle(async (c) => submitAnswerHandler(req, c, (await ctx.params).attemptId));
