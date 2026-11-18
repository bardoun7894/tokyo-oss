/**
 * Price badge burned into a product photo, for sharing on WhatsApp.
 *
 * The caption already carries the name and price (see captionFor() in
 * src/dashboard/products-routes.ts), but a caption does not survive a
 * forward: WhatsApp drops it the moment a customer re-sends the photo to
 * someone else, and an album of several photos shares ONE caption between
 * all of them. Burning the price into the pixels is the only form of it
 * that cannot get separated from the product it belongs to.
 *
 * Same shape as ../dashboard/thumbs.ts: generate once, cache on disk beside
 * the media, return null on any failure so the caller falls back to sending
 * the untouched original rather than sending nothing.
 */
import fs from "fs";
import path from "path";

/** Cache directory, beside the media it mirrors — a sibling of thumbs/. */
export const SHARE_DIR = "share";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** WhatsApp re-compresses anything larger, so there is nothing to gain above this. */
export const SHARE_WIDTH = 1080;

export function isBadgeable(filename: string): boolean {
  return IMAGE_EXT.has(path.extname(filename).toLowerCase());
}

/**
 * Prices are money, and the badge is baked into a file name, so it has to
 * normalise to something stable and filesystem-safe: 67 -> "67",
 * 67.5 -> "67-5". Two different prices can never collide on one cached file,
 * which is what makes "he corrected the price" produce a fresh badge rather
 * than silently reusing the old one.
 */
export function priceKey(price: number): string {
  return String(Math.round(price * 100) / 100).replace(".", "-");
}

export function badgePath(mediaDir: string, filename: string, price: number): string {
  // No dot-directories: express.sendFile 404s any path containing a dot segment.
  return path.join(mediaDir, SHARE_DIR, `${filename}_${priceKey(price)}.jpg`);
}

/** "67 DH", "67.5 DH" — never trailing ".00". */
export function formatPrice(price: number, currency = "DH"): string {
  const rounded = Math.round(price * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} ${currency}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

/**
 * The overlay.
 *
 * Deliberately ASCII-only (digits + the currency code) and pinned to
 * direction="ltr". SVG <text> inherits the RTL direction of its context and
 * reorders Latin runs inside it — that is what broke the Novel logo and seal
 * on every Arabic page of that site. A price is the one string here that must
 * never be reordered, so it never goes near a bidi context: the Arabic
 * product name stays in the WhatsApp caption, where a real text engine
 * handles it.
 *
 * Width is estimated from the glyph count rather than measured — there is no
 * text-measuring API in sharp — so the pill is padded generously and the text
 * is anchored at its centre, which keeps it inside the pill even when the
 * estimate is off by a glyph.
 */
export function badgeSvg(width: number, height: number, label: string): string {
  const fontSize = Math.max(22, Math.round(width * 0.058));
  const padX = Math.round(fontSize * 0.75);
  const padY = Math.round(fontSize * 0.42);
  // 0.62em is about the advance width of DejaVu Sans Bold digits.
  const textW = Math.round(label.length * fontSize * 0.62);
  const pillW = textW + padX * 2;
  const pillH = fontSize + padY * 2;
  const margin = Math.round(width * 0.035);
  const x = margin;
  const y = height - margin - pillH;
  const radius = Math.round(pillH / 2);

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="${radius}" ry="${radius}" fill="#111827" fill-opacity="0.82"/>
  <text x="${x + pillW / 2}" y="${y + pillH / 2}"
        direction="ltr" text-anchor="middle" dominant-baseline="central"
        font-family="DejaVu Sans, FreeSans, sans-serif" font-weight="bold"
        font-size="${fontSize}" fill="#ffffff">${escapeXml(label)}</text>
</svg>`;
}

/**
 * Path of the badged image, generating it if needed. Returns null when it
 * cannot be produced (not an image, sharp missing, corrupt file) so callers
 * send the original instead of failing the whole batch.
 */
export async function ensurePricedImage(
  mediaDir: string,
  filename: string,
  price: number,
  currency = "DH"
): Promise<string | null> {
  if (!isBadgeable(filename)) return null;
  if (!Number.isFinite(price)) return null;
  const out = badgePath(mediaDir, filename, price);
  if (fs.existsSync(out)) return out;
  try {
    const sharp = require("sharp");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // rotate() first: phone photos carry EXIF orientation, and compositing
    // onto an unrotated frame would stamp the price on what becomes the side.
    const base = sharp(path.join(mediaDir, filename))
      .rotate()
      .resize({ width: SHARE_WIDTH, withoutEnlargement: true });
    const { data, info } = await base.toBuffer({ resolveWithObject: true });
    const svg = badgeSvg(info.width, info.height, formatPrice(price, currency));
    await sharp(data)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 86 })
      .toFile(out);
    return out;
  } catch (err: any) {
    console.warn(`[badge] ${filename} @${price}: ${err?.message || err}`);
    return null;
  }
}
