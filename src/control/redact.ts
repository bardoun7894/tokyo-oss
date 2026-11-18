// Scrubs secrets from text before it leaves the host through the Control API (R7).
// Idempotent: every replacement is a token the patterns do not match again.

const PEM = /-----BEGIN [A-Z ]*-----[\s\S]*?-----END [A-Z ]*-----/g;
// Upper-case names that end in a secret word; KEY_COUNT or a lower-case `token` variable stay untouched.
const SECRET_ASSIGN = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASS(?:WORD|PHRASE|WD)?))(\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s'"]+)/g;
const BEARER = /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+\/=-]+/g;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
const AGENT_PATH = /\/home\/tokyo-agent(?:\/[^\s'"]*)?/g;
const HEX_BLOB = /\b[0-9a-f]{40,}\b/g;
const B64_BLOB = /(?=[A-Za-z0-9+\/]*[A-Z0-9+])[A-Za-z0-9+\/]{40,}={0,2}/g;

export function redact(text: string): string {
  return text
    .replace(PEM, "[redacted pem]")
    .replace(SECRET_ASSIGN, "$1$2[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(SK_KEY, "[redacted]")
    .replace(AGENT_PATH, "[path]")
    .replace(HEX_BLOB, "[redacted]")
    .replace(B64_BLOB, "[redacted]");
}
