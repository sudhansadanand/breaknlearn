import { LessonContent, PictureGroupsConfig } from "@bnl/contracts";

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

const MARKUP = /<[^>]*>|javascript:|on\w+\s*=/i;

/**
 * Publish-readiness check. Drafts may be SAVED with errors but not submitted/published (M04).
 * Text fields must be plain text: the student app renders everything as text.
 */
export function validateLessonContent(raw: unknown): ValidationError[] {
  const parsed = LessonContent.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
  }
  const c = parsed.data;
  const errors: ValidationError[] = [];
  if (MARKUP.test(c.title)) errors.push({ path: "title", message: "Title must be plain text (no HTML or scripts)" });
  if (!c.rights.reviewed) errors.push({ path: "rights.reviewed", message: "Rights must be reviewed before publishing" });
  if ((c.rights.type === "licensed" || c.rights.type === "owner_supplied") && !c.rights.attribution) {
    errors.push({ path: "rights.attribution", message: "Attribution is required for licensed or owner-supplied media" });
  }
  if (c.template === "picture_groups_v1") {
    const cfg = PictureGroupsConfig.safeParse(c.config);
    if (!cfg.success) {
      for (const i of cfg.error.issues) errors.push({ path: `config.${i.path.join(".")}`, message: i.message });
    } else {
      if (cfg.data.count_from > cfg.data.count_to) errors.push({ path: "config.count_from", message: "count_from must be ≤ count_to" });
      if (new Set(cfg.data.themes).size !== cfg.data.themes.length) errors.push({ path: "config.themes", message: "Duplicate theme" });
      if (c.subject_key !== "math") errors.push({ path: "subject_key", message: "picture_groups_v1 is a math template" });
    }
  } else {
    errors.push({ path: "template", message: `Template ${c.template} has no renderer yet; it can be drafted but not published` });
  }
  return errors;
}
