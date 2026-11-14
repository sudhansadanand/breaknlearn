import { getLessonHandler } from "../../../../../../server/content/lessons";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request, ctx: { params: Promise<{ lessonId: string }> }) =>
  handle(async (c) => getLessonHandler(req, c, (await ctx.params).lessonId));
