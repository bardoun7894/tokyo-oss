/**
 * Tokyo social publisher — media plumbing.
 *
 * Gets a video onto local disk (Telegram download, server path, or remote URL),
 * probes it with ffprobe, and — for the platforms that refuse a binary upload
 * and insist on fetching a URL themselves (Instagram, Facebook) — exposes it
 * under a public directory nginx serves, then takes it back down afterwards.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type { MediaAsset } from "./types";

const execFileAsync = promisify(execFile);

export const WORK_DIR =
  process.env.SOCIAL_MEDIA_DIR || path.join(__dirname, "..", "..", "social-media");
export const PUBLIC_DIR = process.env.SOCIAL_PUBLIC_DIR || "/var/www/html/tokyo-media";
export const PUBLIC_BASE = (process.env.SOCIAL_PUBLIC_BASE || "").replace(/\/$/, "");

/** Telegram's bot API caps downloads at 20 MB. Bigger clips must come via /share. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export function ensureDirs(): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (PUBLIC_BASE) {
    try {
      fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    } catch (err) {
      console.error(`[social] cannot create public dir ${PUBLIC_DIR}:`, err);
    }
  }
}

export function publicHostingReady(): boolean {
  return Boolean(PUBLIC_BASE) && fs.existsSync(PUBLIC_DIR);
}

function randomName(ext: string): string {
  return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
}

/** Download a Telegram video/document to WORK_DIR and return the local path. */
export async function downloadTelegramFile(
  filePath: string,
  botToken: string,
  ext = ".mp4"
): Promise<string> {
  ensureDirs();
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram download failed: ${res.status} ${res.statusText}`);
  const dest = path.join(WORK_DIR, randomName(path.extname(filePath) || ext));
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/** Download a remote https video to WORK_DIR. */
export async function downloadRemote(url: string): Promise<string> {
  ensureDirs();
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const guessed = path.extname(new URL(url).pathname) || ".mp4";
  const dest = path.join(WORK_DIR, randomName(guessed));
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

/** Probe a local file into a MediaAsset. Throws when it has no video stream. */
export async function probe(filePath: string): Promise<MediaAsset> {
  const stat = fs.statSync(filePath);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const info = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: FfprobeStream[];
  };
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  if (!video) throw new Error("No video stream found in file");

  // A phone clip is often stored landscape with a 90° rotation flag; the
  // platforms read the display orientation, so swap the axes to match.
  const rotation =
    Number(video.tags?.rotate ?? 0) ||
    Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const swapped = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;

  const width = (swapped ? video.height : video.width) || 0;
  const height = (swapped ? video.width : video.height) || 0;

  return {
    path: filePath,
    mime: filePath.endsWith(".mov") ? "video/quicktime" : "video/mp4",
    sizeBytes: stat.size,
    durationSec: Number(info.format?.duration ?? video.duration ?? 0),
    width,
    height,
  };
}

/**
 * Hard-link (falling back to copy) the asset into the public dir and return
 * its https URL. No-op when public hosting is not configured.
 */
export function expose(asset: MediaAsset): string | undefined {
  if (!publicHostingReady()) return undefined;
  const name = randomName(path.extname(asset.path) || ".mp4");
  const dest = path.join(PUBLIC_DIR, name);
  try {
    fs.linkSync(asset.path, dest);
  } catch {
    fs.copyFileSync(asset.path, dest);
  }
  try {
    fs.chmodSync(dest, 0o644);
  } catch {
    /* best effort — nginx just needs read */
  }
  return `${PUBLIC_BASE}/${name}`;
}

export function unexpose(publicUrl?: string): void {
  if (!publicUrl || !PUBLIC_BASE || !publicUrl.startsWith(PUBLIC_BASE)) return;
  const name = path.basename(new URL(publicUrl).pathname);
  try {
    fs.unlinkSync(path.join(PUBLIC_DIR, name));
  } catch {
    /* already gone */
  }
}

/** Read one slice of a file — used by the chunked upload adapters. */
export function readChunk(filePath: string, start: number, length: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Delete anything older than `hours` from the work and public dirs. */
export function sweep(hours = 48): number {
  const cutoff = Date.now() - hours * 3600 * 1000;
  let removed = 0;
  for (const dir of [WORK_DIR, publicHostingReady() ? PUBLIC_DIR : null]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        /* skip */
      }
    }
  }
  return removed;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function humanDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
