/**
 * Log redaction (spec M01/M12: logs exclude child names, answers, raw tokens).
 * Deep-copies a value replacing sensitive keys and sensitive-looking strings.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(^|_|-)(name|display_?name|first_?name|last_?name|full_?name|answer|answers|selected_option(_id)?|email|e_?mail|password|passwd|token|access_token|refresh_token|id_token|secret|poll_secret|code|pairing_code|authorization|cookie|set-cookie|csrf|api_?key|apikey)($|_|-)/i;
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactString(value: string): string {
  return value.replace(BEARER, `Bearer ${REDACTED}`).replace(JWT, REDACTED).replace(EMAIL, REDACTED);
}

function isSensitiveKey(key: string): boolean {
  // camelCase -> snake_case so `displayName` and `refreshToken` match too.
  const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_KEY.test(snake);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    // `type` rather than `name`: a `name` key would itself be redacted as a person's name.
    return { type: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
