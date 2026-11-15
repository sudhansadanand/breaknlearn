import { catalogLessonHandler } from "../../../../../../server/content/catalog";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PUBLIC_PUBLISHED: the live version only; 404 for anything else. */
export const GET = (req: Request, ctx: { params: Promise<{ lessonId: string }> }) =>
  handle(async (c) => catalogLessonHandler(req, c, (await ctx.params).lessonId));
