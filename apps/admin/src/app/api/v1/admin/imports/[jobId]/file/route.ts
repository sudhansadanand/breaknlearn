import { importFileHandler } from "../../../../../../../server/curriculum/import-handlers";
import { handle } from "../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request, ctx: { params: Promise<{ jobId: string }> }) =>
  handle(async (c) => importFileHandler(req, c, (await ctx.params).jobId));
