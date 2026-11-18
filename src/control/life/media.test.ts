import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import Database from "better-sqlite3";

// Scratch db and media dir BEFORE anything imports ../../db or the dashboard router.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-life-media-"));
process.env.TOKYO_DB_PATH = path.join(dir, "life.db");
const MEDIA = path.join(dir, "media");
fs.mkdirSync(MEDIA);
process.env.TOKYO_MEDIA_DIR = MEDIA;
test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  // The dashboard router pulls in Baileys and other modules that hold the event loop open; every assertion has already run.
  setImmediate(() => process.exit(0));
});

import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { auditParams } from "./gateway";
import { clampThumbWidth, isMediaName, uploadRefusal } from "./media";
import { LIFE_ROWS } from "./table";

const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
fs.writeFileSync(path.join(MEDIA, "wa_100.jpg"), JPEG);
fs.writeFileSync(path.join(MEDIA, "wa_101.ogg"), Buffer.from("OggS-not-really"));
fs.writeFileSync(path.join(MEDIA, "wa_big.mp4"), Buffer.alloc(2000));
fs.writeFileSync(path.join(dir, "secret.txt"), "top secret");
fs.writeFileSync(path.join(MEDIA, "plain.jpg"), JPEG);

interface Opts { maxBytes?: number; uploads?: boolean }

/** A control app around either the real dashboard router or a spy that records the url it was given. */
async function setup(kind: "real" | "spy", opts: Opts = {}) {
  const db = new Database(":memory:");
  const seen: { method: string; url: string; bytes: number; type: string | undefined }[] = [];
  let dashboard: express.RequestHandler;
  if (kind === "real") {
    dashboard = (await import("../../dashboard/routes")).default as unknown as express.RequestHandler;
  } else {
    const spy = express.Router();
    spy.use((req, res) => {
      let bytes = 0;
      req.on("data", (c: Buffer) => { bytes += c.length; });
      req.on("end", () => { seen.push({ method: req.method, url: req.url, bytes, type: req.headers["content-type"] }); res.json({ ok: true, bytes }); });
    });
    dashboard = spy;
  }
  const t = await controlApp({
    life: { dashboard, ops: new OpsStore(db), media: { dir: () => MEDIA, maxBytes: opts.maxBytes ?? 1000, uploads: () => opts.uploads ?? false } } as any,
  }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, ["life:read", "life:write"]);
  return { ...t, db, seen };
}

test("isMediaName is the dashboard's file rule: wa_ prefix, no .., no slash, no backslash, no NUL", () => {
  for (const ok of ["wa_100.jpg", "wa_3EB0A1B2C3.ogg", "wa_x"]) assert.equal(isMediaName(ok), true, ok);
  for (const bad of ["", "x.jpg", "WA_1.jpg", "wa_..", "wa_a..b.jpg", "wa_a/b.jpg", "/wa_a.jpg", "../wa_a.jpg", "wa_a\\b.jpg", "wa_a\0.jpg", "wa_" + "x".repeat(300), ".", ".."]) {
    assert.equal(isMediaName(bad), false, JSON.stringify(bad));
  }
});

test("clampThumbWidth snaps into the dashboard's widths 160..640 (a tie goes up) and ignores anything that is not a number", () => {
  const table: [unknown, number | null][] = [
    [undefined, null], ["", null], ["abc", null], ["NaN", null], ["Infinity", 640], ["-Infinity", 160], [["1", "2"], null],
    ["0", 160], ["-5", 160], ["1", 160], ["160", 160], ["200", 240], ["201", 240], ["300", 320], ["320", 320], ["400", 480], ["640", 640], ["5000", 640], ["1e9", 640], ["320.7", 320],
  ];
  for (const [raw, want] of table) assert.equal(clampThumbWidth(raw), want, JSON.stringify(raw));
});

test("the real dashboard serves a gallery file through the gateway with its own content type, on the bearer alone", async () => {
  const t = await setup("real");
  const r = await t.srv.call("GET", "/control-api/v1/life/api/media/wa_100.jpg", undefined, t.auth);
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /^image\/jpeg/);
  const ogg = await t.srv.call("GET", "/control-api/v1/life/api/media/wa_101.ogg", undefined, t.auth);
  assert.equal(ogg.status, 200);
  assert.match(String(ogg.headers["content-type"]), /ogg|audio/);
  const missing = await t.srv.call("GET", "/control-api/v1/life/api/media/wa_nope.jpg", undefined, t.auth);
  assert.deepEqual([missing.status, missing.json.error.code], [404, "not_found"], "the dashboard's own 404 in the control envelope");
  await t.close();
});

test("a name outside the dashboard's rule is 404 and never reaches the dashboard: traversal, absolute, .., encoded, wrong prefix", async () => {
  const t = await setup("spy");
  const names = ["plain.jpg", "..", "wa_..", "wa_%2e%2e", "wa_%2E%2E%2E", "wa_a%2e%2eb.jpg", "wa_a..b.jpg", "wa_%2e%2e%2fsecret.txt", "wa_..%2Fsecret.txt", "%2e%2e%2fsecret.txt", "%2Froot%2Fsecret.txt", "wa_a%2Fb.jpg", "wa_a%5Cb.jpg", "WA_100.jpg", "wa_a%00.jpg"];
  for (const n of names) {
    const r = await t.srv.call("GET", "/control-api/v1/life/api/media/" + n, undefined, t.auth);
    assert.equal(r.status, 404, n);
    assert.equal(r.json.error.code, "not_found", n);
  }
  for (const p of ["/media/wa_a/../../secret.txt", "/media//etc/passwd", "/media/", "/media"]) {
    assert.equal((await t.srv.call("GET", "/control-api/v1/life/api" + p, undefined, t.auth)).status, 404, p);
  }
  assert.equal(t.seen.length, 0, "none of them reached the dashboard");
  // Through the real handler the same names are not served either.
  const real = await setup("real");
  for (const n of ["..%2Fsecret.txt", "wa_%2e%2e%2fsecret.txt"]) assert.equal((await real.srv.call("GET", "/control-api/v1/life/api/media/" + n, undefined, real.auth)).status, 404, n);
  await real.close();
  await t.close();
});

test("w is clamped to the dashboard's widths and the other query parameters are dropped", async () => {
  const t = await setup("spy", { maxBytes: 1_000_000 });
  const url = async (q: string) => { t.seen.length = 0; await t.srv.call("GET", "/control-api/v1/life/api/media/wa_100.jpg" + q, undefined, t.auth); return t.seen[0]?.url; };
  assert.equal(await url(""), "/api/media/wa_100.jpg");
  assert.equal(await url("?w=320"), "/api/media/wa_100.jpg?w=320");
  assert.equal(await url("?w=5000"), "/api/media/wa_100.jpg?w=640");
  assert.equal(await url("?w=1"), "/api/media/wa_100.jpg?w=160");
  assert.equal(await url("?w=300"), "/api/media/wa_100.jpg?w=320");
  assert.equal(await url("?w=abc"), "/api/media/wa_100.jpg");
  assert.equal(await url("?w=320&w=5000"), "/api/media/wa_100.jpg?w=320", "the first w counts");
  t.seen.length = 0;
  await t.srv.call("GET", "/control-api/v1/life/api/media/wa_%31%30%30.jpg", undefined, t.auth);
  assert.equal(t.seen[0]?.url, "/api/media/wa_100.jpg", "an escaped letter is decoded, checked, and passed on in one form");
  assert.equal(await url("?x=1&w=480&y=../../etc"), "/api/media/wa_100.jpg?w=480");
  await t.close();
});

test("a file over the size cap is 413 bad_request; a thumbnail request on an image is not checked against it", async () => {
  const t = await setup("spy", { maxBytes: 1000 });
  const big = await t.srv.call("GET", "/control-api/v1/life/api/media/wa_big.mp4", undefined, t.auth);
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, "bad_request");
  assert.equal(t.seen.length, 0);
  assert.equal((await t.srv.call("GET", "/control-api/v1/life/api/media/wa_100.jpg", undefined, t.auth)).status, 200, "small file under the cap");
  assert.equal((await t.srv.call("GET", "/control-api/v1/life/api/media/wa_big.mp4?w=320", undefined, t.auth)).status, 413, "not an image, so ?w falls back to the original");
  assert.equal((await t.srv.call("GET", "/control-api/v1/life/api/media/wa_absent.jpg", undefined, t.auth)).status, 200, "a missing file is the dashboard's 404 to give");
  await t.close();
});

test("the media and upload rows are flagged in the table and no other row is", () => {
  const flagged = LIFE_ROWS.filter((r) => r.kind).map((r) => [r.id, r.kind]);
  assert.deepEqual(flagged, [["L8", "bytes"], ["L80", "upload"], ["L96", "upload"]]);
});

test("uploads are off until the flag is set: 503 unavailable, the dashboard is not called", async () => {
  const t = await setup("spy", { uploads: false });
  for (const p of ["/content/items/5/upload?name=a.mp4", "/transcripts/upload?ext=ogg"]) {
    const r = await t.srv.call("POST", "/control-api/v1/life/api" + p, "abc", { ...t.auth, "content-type": "application/octet-stream", "idempotency-key": "u" + p.length });
    assert.equal(r.status, 503, p);
    assert.equal(r.json.error.code, "unavailable");
  }
  assert.equal(t.seen.length, 0);
  await t.close();
});

test("with uploads on, the raw body reaches the dashboard untouched and a replayed key does not upload twice", async () => {
  const t = await setup("spy", { uploads: true });
  const body = "x".repeat(5000);
  const send = (key: string) => t.srv.call("POST", "/control-api/v1/life/api/content/items/5/upload?name=a.mp4", body, { ...t.auth, "content-type": "application/octet-stream", "idempotency-key": key });
  const r = await send("up-1");
  assert.deepEqual([r.status, r.json], [200, { ok: true, bytes: 5000 }]);
  assert.deepEqual(t.seen.map((s) => [s.url, s.bytes, s.type]), [["/api/content/items/5/upload?name=a.mp4", 5000, "application/octet-stream"]]);
  const again = await send("up-1");
  assert.deepEqual([again.status, again.json.bytes], [200, 5000]);
  assert.equal(t.seen.length, 1, "replayed");
  const audit = t.db.prepare("SELECT action, params FROM control_ops_audit").all() as { action: string; params: string }[];
  assert.deepEqual(audit.map((a) => a.action), ["life.POST.L80"]);
  const noKey = await t.srv.call("POST", "/control-api/v1/life/api/transcripts/upload", "abc", { ...t.auth, "content-type": "audio/ogg" });
  assert.equal(noKey.status, 400, "an upload is a write and needs its key");
  await t.close();
});

test("uploadRefusal: Content-Length over the dashboard's cap is 413 before a byte is read; L80 follows CONTENT_UPLOAD_MAX_MB, L96 is 25 MB", () => {
  const row = (id: string) => LIFE_ROWS.find((r) => r.id === id)!;
  const req = (len?: string) => ({ headers: len === undefined ? {} : { "content-length": len } }) as any;
  const MB = 1024 * 1024;
  const keep = process.env.CONTENT_UPLOAD_MAX_MB;
  try {
    delete process.env.CONTENT_UPLOAD_MAX_MB;
    assert.equal(uploadRefusal(row("L96"), req(String(25 * MB)), true), null);
    assert.equal(uploadRefusal(row("L96"), req(String(25 * MB + 1)), true)?.status, 413);
    assert.equal(uploadRefusal(row("L96"), req(undefined), true), null, "chunked: the dashboard counts the bytes");
    assert.equal(uploadRefusal(row("L96"), req("abc"), true)?.status, 400, "a malformed length");
    assert.equal(uploadRefusal(row("L80"), req(String(4096 * MB)), true), null);
    assert.equal(uploadRefusal(row("L80"), req(String(4096 * MB + 1)), true)?.status, 413);
    process.env.CONTENT_UPLOAD_MAX_MB = "2";
    assert.equal(uploadRefusal(row("L80"), req(String(2 * MB)), true), null);
    assert.equal(uploadRefusal(row("L80"), req(String(2 * MB + 1)), true)?.status, 413);
    assert.equal(uploadRefusal(row("L80"), req("10"), false)?.status, 503, "off beats everything");
    assert.equal(uploadRefusal(row("L42"), req("999999999999"), false), null, "only upload rows");
  } finally {
    if (keep === undefined) delete process.env.CONTENT_UPLOAD_MAX_MB; else process.env.CONTENT_UPLOAD_MAX_MB = keep;
  }
});

test("the audit never walks a raw upload body", () => {
  const big = Buffer.alloc(30 * 1024 * 1024);
  const started = Date.now();
  assert.deepEqual(JSON.parse(auditParams(big)), { fields: [] });
  assert.ok(Date.now() - started < 500);
});

test("the nginx upload snippet: two exact upload locations with 30m and 120s, the Control location untouched", () => {
  const conf = fs.readFileSync(path.join(process.cwd(), "ops", "nginx", "control-uploads.location.conf"), "utf8");
  const code = conf.split("\n").map((l) => l.replace(/\s#.*$/, "").replace(/^\s*#.*$/, "")).join("\n");
  const locations = [...code.matchAll(/location\s+(\^~\s+|~\s+)?(\S+)\s*\{/g)].map((m) => m[2]);
  assert.ok(locations.includes("/control/api/v1/life/api/transcripts/upload"), locations.join(" "));
  assert.ok(locations.some((l) => l.includes("content/items/") && l.endsWith("/upload$")), locations.join(" "));
  assert.ok(!locations.includes("/control/api/v1/"), "the general location stays in control.location.conf");
  const sizes = [...code.matchAll(/client_max_body_size\s+(\S+);/g)].map((m) => m[1]);
  assert.ok(sizes.includes("30m"));
  assert.match(code, /proxy_read_timeout\s+120s;/);
  assert.ok(!/proxy_add_x_forwarded_for/.test(code), "X-Forwarded-For is overwritten, never appended");
  assert.match(code, /proxy_set_header\s+X-Real-IP\s+\$remote_addr;/);
  assert.ok(!/location\s+\/\s/.test(code));
});
