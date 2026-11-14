import { revokeDeviceHandler } from "../../../../../../server/handlers/devices";
import { handle } from "../../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request, ctx: { params: Promise<{ deviceId: string }> }) =>
  handle(async (c) => revokeDeviceHandler(req, c, (await ctx.params).deviceId));
