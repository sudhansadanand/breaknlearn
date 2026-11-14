import { pinHandler } from "../../../../../../../server/content/lessons";
import { handle } from "../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ revision: string }> }) =>
  handle(async (c) => pinHandler(req, c, (await ctx.params).revision));
