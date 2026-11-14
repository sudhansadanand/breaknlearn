import { createImportHandler, listImportsHandler } from "../../../../../server/curriculum/import-handlers";
import { handle } from "../../../../../server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (req: Request) => handle((c) => listImportsHandler(req, c));
export const POST = (req: Request) => handle((c) => createImportHandler(req, c));
