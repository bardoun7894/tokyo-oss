import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensurePricedImage, badgePath, badgeSvg, formatPrice, priceKey, isBadgeable, SHARE_WIDTH } from "./badge";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tokyo-badge-"));
  const sharp = require("sharp");
  // A tall photo, wider than SHARE_WIDTH, so the resize path is exercised.
  await sharp({ create: { width: 1600, height: 2000, channels: 3, background: "#cccccc" } })
    .jpeg()
    .toFile(join(dir, "photo.jpg"));
  await sharp({ create: { width: 400, height: 500, channels: 3, background: "#cccccc" } })
    .jpeg()
    .toFile(join(dir, "small.jpg"));
  writeFileSync(join(dir, "notes.txt"), "not an image");
  writeFileSync(join(dir, "corrupt.jpg"), "still not an image");
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("formatPrice drops trailing zeros but keeps real decimals", () => {
  assert.equal(formatPrice(67), "67 DH");
  assert.equal(formatPrice(67.5), "67.50 DH");
  assert.equal(formatPrice(67.004), "67 DH");
  assert.equal(formatPrice(120, "MAD"), "120 MAD");
});

test("priceKey is filesystem-safe and distinct per price", () => {
  assert.equal(priceKey(67), "67");
  assert.equal(priceKey(67.5), "67-5");
  assert.notEqual(priceKey(67), priceKey(68));
  assert.ok(!priceKey(67.5).includes("."), "a dot would make express.sendFile 404 the path");
});

test("isBadgeable accepts photos and refuses everything else", () => {
  assert.ok(isBadgeable("a.jpg"));
  assert.ok(isBadgeable("A.JPEG"));
  assert.ok(isBadgeable("a.webp"));
  assert.ok(!isBadgeable("a.mp4"));
  assert.ok(!isBadgeable("a.txt"));
  assert.ok(!isBadgeable("a"));
});

test("the badge never inherits an RTL context", () => {
  const svg = badgeSvg(1080, 1350, "67 DH");
  assert.match(svg, /direction="ltr"/, "SVG text reorders Latin runs under RTL — the price must be pinned LTR");
  assert.ok(!/dir="rtl"|direction="rtl"/.test(svg));
  assert.match(svg, />67 DH</, "the price renders as one unreordered run");
});

test("ensurePricedImage writes a badged jpeg capped at the share width", async () => {
  const out = await ensurePricedImage(dir, "photo.jpg", 67);
  assert.equal(out, badgePath(dir, "photo.jpg", 67));
  assert.ok(existsSync(out as string));
  const meta = await require("sharp")(out).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, SHARE_WIDTH, "a 1600px original is resized down for sending");
  assert.equal(meta.height, 1350, "aspect ratio preserved");
});

test("a photo smaller than the share width is not upscaled", async () => {
  const out = await ensurePricedImage(dir, "small.jpg", 40);
  const meta = await require("sharp")(out).metadata();
  assert.equal(meta.width, 400);
});

test("the second call reuses the cached file instead of re-rendering", async () => {
  const first = (await ensurePricedImage(dir, "photo.jpg", 99)) as string;
  const stamp = statSync(first).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const second = await ensurePricedImage(dir, "photo.jpg", 99);
  assert.equal(second, first);
  assert.equal(statSync(first).mtimeMs, stamp, "cached render must not be rewritten");
});

test("a corrected price renders a new image rather than reusing the old badge", async () => {
  const at67 = (await ensurePricedImage(dir, "photo.jpg", 67)) as string;
  const at80 = (await ensurePricedImage(dir, "photo.jpg", 80)) as string;
  assert.notEqual(at67, at80, "the cache key must include the price, or a fix would still show the wrong number");
  assert.ok(existsSync(at80));
});

test("unbadgeable and corrupt input returns null so the caller can send the original", async () => {
  assert.equal(await ensurePricedImage(dir, "notes.txt", 10), null);
  assert.equal(await ensurePricedImage(dir, "corrupt.jpg", 10), null);
  assert.equal(await ensurePricedImage(dir, "missing.jpg", 10), null);
  assert.equal(await ensurePricedImage(dir, "photo.jpg", NaN), null);
});
