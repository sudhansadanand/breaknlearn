import { unpublishHandler } from "../../../../../../../server/content/lessons";
import { handle } from "../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ lessonId: string }> }) =>
  handle(async (c) => unpublishHandler(req, c, (await ctx.params).lessonId));
