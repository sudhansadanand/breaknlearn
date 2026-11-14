import { reviewCurriculumHandler } from "../../../../../../../server/curriculum/curriculum-handlers";
import { handle } from "../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ nodeId: string }> }) =>
  handle(async (c) => reviewCurriculumHandler(req, c, (await ctx.params).nodeId));
