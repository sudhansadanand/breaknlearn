import * as legacyImport from "../../src/app/api/v1/progress/legacy-import/route";
import * as progress from "../../src/app/api/v1/progress/route";
import * as progressSync from "../../src/app/api/v1/progress/sync/route";
import * as telemetryBatch from "../../src/app/api/v1/telemetry/batch/route";

export const learningRoutes = { telemetryBatch, progress, progressSync, legacyImport };
