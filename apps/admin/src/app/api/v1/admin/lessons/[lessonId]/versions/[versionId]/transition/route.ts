import { transitionHandler } from "../../../../../../../../../server/content/lessons";
import { handle } from "../../../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ lessonId: string; versionId: string }> }) =>
  handle(async (c) => {
    const p = await ctx.params;
    return transitionHandler(req, c, p.lessonId, p.versionId);
  });
