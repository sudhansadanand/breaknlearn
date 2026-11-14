import { previewHandler } from "../../../../../../../../../server/content/lessons";
import { handle } from "../../../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request, ctx: { params: Promise<{ lessonId: string; versionId: string }> }) =>
  handle(async (c) => {
    const p = await ctx.params;
    return previewHandler(req, c, p.lessonId, p.versionId);
  });
