import fs from "fs";
import path from "path";
import type { Request } from "express";
import { mediaDir } from "../../media-dir";
import { THUMB_WIDTHS, isThumbnailable } from "../../dashboard/thumbs";
import type { LifeRow } from "./table";

// The byte routes of the life gateway (T4.4): the gallery file (L8) and the two raw uploads (L80, L96). The dashboard's handlers still do
// the work; this module only decides, before they run, whether a request may reach them.

const MB = 1024 * 1024;

export interface MediaOptions {
  /** The WhatsApp media directory, resolved per request (tests move it). */
  dir: () => string;
  /** Largest file served as bytes; a bigger one is 413. */
  maxBytes: number;
  /** The uploads switch: off until the nginx upload location exists (Z4). */
  uploads: () => boolean;
}

export const MAX_MEDIA_BYTES = 100 * MB;

export function defaultMedia(): MediaOptions {
  return { dir: mediaDir, maxBytes: MAX_MEDIA_BYTES, uploads: () => process.env.CONTROL_LIFE_UPLOADS === "1" };
}

/** The dashboard's own rule for `GET /api/media/:filename` (src/dashboard/routes.ts): a `wa_` name with no `..` and no path separator. */
export function isMediaName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && name.startsWith("wa_") && !name.includes("..") && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * The thumbnail width to ask the dashboard for, or null to serve the original. A number is clamped into the widths the dashboard
 * offers (160..640) and snapped to the nearest one; anything that is not a number is dropped.
 */
export function clampThumbWidth(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  const lo = THUMB_WIDTHS[0];
  const hi = THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
  const c = Math.min(hi, Math.max(lo, n));
  return THUMB_WIDTHS.reduce((best, w) => (Math.abs(w - c) <= Math.abs(best - c) ? w : best));
}

export interface Refusal { status: number; code: "not_found" | "bad_request" | "unavailable"; message: string }

/**
 * Checks a gallery request and rewrites `req.url` so the dashboard sees the name and the clamped `w` only. Called with the url still in
 * gateway form (`/media/<name>?...`).
 */
export function mediaRefusal(req: Request, opts: MediaOptions): Refusal | null {
  // The rule is applied to the decoded name, which is what the dashboard's req.params.filename will be.
  let name: string;
  try { name = decodeURIComponent(req.path.slice("/media/".length)); } catch { return { status: 404, code: "not_found", message: "Not found" }; }
  if (!isMediaName(name)) return { status: 404, code: "not_found", message: "Not found" };
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
  const width = clampThumbWidth(new URLSearchParams(query).get("w") ?? undefined);
  req.url = `/media/${encodeURIComponent(name)}` + (width ? `?w=${width}` : "");
  // A thumbnail of an image is small; everything else is the original, whatever w says.
  if (width && isThumbnailable(name)) return null;
  let size: number;
  try { size = fs.statSync(path.join(opts.dir(), name)).size; } catch { return null; } // absent: the dashboard answers 404
  if (size > opts.maxBytes) return { status: 413, code: "bad_request", message: "File is too large for the app" };
  return null;
}

/** The dashboard's cap for the body of an upload row. */
function uploadCap(row: LifeRow): number {
  if (row.id === "L80") return Number(process.env.CONTENT_UPLOAD_MAX_MB || 4096) * MB; // content-routes.ts MAX_UPLOAD_BYTES
  return row.bodyLimit;
}

/** Why an upload may not start, or null: switched off (503), or a declared length over the dashboard's cap (413, before a byte is read). */
export function uploadRefusal(row: LifeRow, req: Pick<Request, "headers">, enabled: boolean): Refusal | null {
  if (row.kind !== "upload") return null;
  if (!enabled) return { status: 503, code: "unavailable", message: "Uploads are not enabled" };
  const declared = req.headers["content-length"];
  if (declared === undefined) return null; // chunked: the dashboard counts the bytes it receives
  const n = Number(declared);
  if (!Number.isInteger(n) || n < 0) return { status: 400, code: "bad_request", message: "Bad Content-Length" };
  if (n > uploadCap(row)) return { status: 413, code: "bad_request", message: `Upload is over the ${Math.round(uploadCap(row) / MB)} MB limit` };
  return null;
}
