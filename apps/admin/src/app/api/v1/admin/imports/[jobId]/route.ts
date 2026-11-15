import { getImportHandler } from "../../../../../../server/curriculum/import-handlers";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request, ctx: { params: Promise<{ jobId: string }> }) =>
  handle(async (c) => getImportHandler(req, c, (await ctx.params).jobId));
