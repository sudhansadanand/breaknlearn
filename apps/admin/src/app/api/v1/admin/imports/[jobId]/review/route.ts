import { reviewImportHandler } from "../../../../../../../server/curriculum/import-handlers";
import { handle } from "../../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ jobId: string }> }) =>
  handle(async (c) => reviewImportHandler(req, c, (await ctx.params).jobId));
