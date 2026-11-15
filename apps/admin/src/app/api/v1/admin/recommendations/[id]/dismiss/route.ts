import { dismissRecommendationHandler } from "../../../../../../../server/analytics";
import { handle } from "../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  handle(async (c) => dismissRecommendationHandler(req, c, (await ctx.params).id ?? ""));
