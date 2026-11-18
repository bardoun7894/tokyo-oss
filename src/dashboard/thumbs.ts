// Thumbnails for the media gallery.
//
// The grid used to download the full photo for every tile — a few megabytes per
// screen, so most tiles stayed grey while the originals arrived. A tile asks for
// ?w=320 instead and gets a webp that size, generated once and cached on disk
// next to the media.

import fs from "fs";
import path from "path";

/** The cache directory, beside the media it mirrors. */
export const THUMB_DIR = "thumbs";

/** Only these widths, so a caller cannot fill the disk with arbitrary sizes. */
export const THUMB_WIDTHS = [160, 240, 320, 480, 640] as const;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** The requested width, or null to serve the original. */
export function parseThumbWidth(raw: unknown): number | null {
  const n = Number(raw);
  return (THUMB_WIDTHS as readonly number[]).includes(n) ? n : null;
}

export function isThumbnailable(filename: string): boolean {
  return IMAGE_EXT.has(path.extname(filename).toLowerCase());
}

export function thumbPath(mediaDir: string, filename: string, width: number): string {
  // No dot on the directory: express.sendFile 404s any path with a dot-segment.
  return path.join(mediaDir, "thumbs", String(width), `${filename}.webp`);
}

/**
 * Path of the cached thumbnail, generating it if needed. Returns null when the
 * file cannot be resized (not an image, sharp missing, corrupt file) so the
 * caller falls back to the original rather than failing the request.
 */
export async function ensureThumb(mediaDir: string, filename: string, width: number): Promise<string | null> {
  if (!isThumbnailable(filename)) return null;
  const out = thumbPath(mediaDir, filename, width);
  if (fs.existsSync(out)) return out;
  try {
    const sharp = require("sharp");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // withoutEnlargement: a photo narrower than the tile is copied, not upscaled.
    await sharp(path.join(mediaDir, filename))
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(out);
    return out;
  } catch (err: any) {
    console.warn(`[thumbs] ${filename} @${width}: ${err?.message || err}`);
    return null;
  }
}

/** Drop every cached size of a file, e.g. when the original is deleted. */
export function removeThumbs(mediaDir: string, filename: string): void {
  for (const width of THUMB_WIDTHS) {
    try { fs.unlinkSync(thumbPath(mediaDir, filename, width)); } catch { /* not cached at this size */ }
  }
}
