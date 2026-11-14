import { handle } from "../../../../../server/http";
import { legacyImportHandler } from "../../../../../server/learning/legacy-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handle((c) => legacyImportHandler(req, c));
