/**
 * Deterministic title/brand extraction from an already-transcribed supplier
 * image caption. No LLM calls — the transcription pipeline already ran; this
 * just parses text.
 */

const WRAPPER_RE = /\[Image\]\s*\[Transcription:\s*([\s\S]*)\]\s*$/i;

const GARMENT_KEYWORDS = [
  "kaftan", "jalabiya", "gandoura", "djellaba", "nightgown", "pajama",
  "loungewear", "robe", "dress", "tunic", "abaya", "thobe", "burnout",
  "swatch", "set",
];

const COLOUR_KEYWORDS = [
  "black", "white", "grey", "gray", "beige", "taupe", "brown", "navy",
  "blue", "green", "pink", "mauve", "red", "gold", "silver", "leopard",
  "animal print", "striped", "polka",
];

/** Strip the `[Image] [Transcription: ...]` wrapper if present, else return trimmed input. */
function stripWrapper(content: string): string {
  const m = content.match(WRAPPER_RE);
  return (m ? m[1] : content).trim();
}

/**
 * Does a `**bold**` markdown candidate actually read like a supplier brand
 * name, as opposed to a garment/fabric description, a size/code/price line,
 * or a label such as "Text:"? Evidence from the real 2026 catalog:
 *   accept  — "Aya Mode", "SIAVN STYLES", "Fati Fleur", "Israa Mode",
 *             "أزياء ياقوت", "أزياء شمس", "أزياء أسماء"
 *   reject  — "cream/off-white jacquard fabric garment" (lowercase, descriptive)
 *             "traditional Arabic/Algerian dresses (قمصان/ستاني)" (garment keyword)
 *             "Text:", "Size: 2XL", "Code: 071", "3XL, 4XL" (labels/sizes/codes)
 *             "ريب جكار", "منية ريب XXL", "خيط زقلي" (fabric/style names, not a brand)
 * Real Arabic brand mentions in this catalog consistently open with "أزياء"
 * ("apparel/fashion of ..."); real Latin brand mentions are proper nouns —
 * every word capitalized — while descriptive transcription phrases are
 * plain sentence-case.
 */
function looksLikeBrand(candidate: string): boolean {
  const c = candidate.trim();
  if (!c || c.length > 40) return false;
  if (c.endsWith(":")) return false; // "Text:", "Price:" labels
  if (/\d/.test(c)) return false; // sizes ("2XL"), codes ("071"), prices carry digits
  const lower = c.toLowerCase();
  if (GARMENT_KEYWORDS.some((kw) => lower.includes(kw))) return false;
  if (/[؀-ۿ]/.test(c)) {
    return c.startsWith("أزياء");
  }
  return c.split(/\s+/).every((w) => /^[A-Z]/.test(w));
}

/**
 * First double-quoted name wins (existing supplier convention). When no
 * quotes are present, fall back to the first `**bold**` segment that looks
 * like a brand — the transcription pipeline now emphasizes brand names with
 * markdown bold as often as with quotes, and skipping that convention was
 * leaving `brand: null` (and therefore a generic, collision-prone title) on
 * a majority of real captions.
 */
function extractBrand(stripped: string): string | null {
  const quoted = stripped.match(/"([^"]+)"/);
  if (quoted) return quoted[1].trim();

  const boldRe = /\*\*([^*]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(stripped)) !== null) {
    const candidate = m[1].trim();
    if (looksLikeBrand(candidate)) return candidate;
  }
  return null;
}

/** First matching keyword *in reading order* — leftmost occurrence wins, not list order. */
function findKeyword(haystackLower: string, keywords: string[]): string | null {
  let best: { kw: string; idx: number } | null = null;
  for (const kw of keywords) {
    const idx = haystackLower.indexOf(kw);
    if (idx !== -1 && (best === null || idx < best.idx)) best = { kw, idx };
  }
  return best ? best.kw : null;
}

function fallbackTitle(messageId?: number): string {
  return messageId != null ? `Product #${messageId}` : "Product";
}

export function extractTitle(content: string, messageId?: number): { title: string; brand: string | null } {
  if (!content || !content.trim()) {
    return { title: fallbackTitle(messageId), brand: null };
  }

  const stripped = stripWrapper(content);
  const brand = extractBrand(stripped);

  const lower = stripped.toLowerCase();
  const garment = findKeyword(lower, GARMENT_KEYWORDS);
  const colour = findKeyword(lower, COLOUR_KEYWORDS);

  let body: string;
  if (garment || colour) {
    body = [garment, colour].filter(Boolean).join(" ");
  } else {
    const firstSentence = stripped.split(/[.!?\n]/)[0]?.trim() || "";
    body = firstSentence.slice(0, 80).trim();
  }

  let title = brand ? (body ? `${brand} — ${body}` : brand) : body;
  title = title.trim();
  if (!title) title = fallbackTitle(messageId);

  return { title, brand };
}

/**
 * Prefer `content` (carries the `[Image] [Transcription: ...]` wrapper);
 * fall back to the separate `transcription` column when `content` has no
 * wrapper. Neither source is guaranteed non-null.
 */
export function resolveCaption(content: string | null, transcription: string | null): string {
  if (content && WRAPPER_RE.test(content)) return content;
  if (transcription && transcription.trim()) return transcription;
  if (content && content.trim()) return content;
  return "";
}
