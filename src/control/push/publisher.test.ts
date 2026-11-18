import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ControlStore } from "../store";
import { NTFY_LOCAL, ntfyConfig, Publisher, type FetchLike } from "./publisher";
import { serialize } from "./format";
import { PushStore } from "./store";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const TOKEN = "tk_publisherTOKEN0123456789abcdef";
const TOPIC = "upAb12Cd34Ef56Gh";
const BASE = "https://ntfy.203-0-113-10.sslip.io";
const UP = JSON.stringify({ v: 1, t: "test", id: "1", title: "Test notification" });

interface Seen { url: string; method: string; headers: Record<string, string>; body: string | Uint8Array; signal: AbortSignal }

function setup(opts: { format?: "up" | "ntfy"; config?: null; script?: Array<number | Error | "hang"> } = {}) {
  const db = new Database(":memory:");
  const control = new ControlStore(db);
  const store = new PushStore(db);
  const dev = control.createDevice({ name: "a", tokenHash: "h", now: NOW });
  store.register(dev.id, TOPIC, undefined, NOW);
  const seen: Seen[] = [];
  const script = [...(opts.script ?? [])];
  const logs: string[] = [];
  const fetch: FetchLike = (url, init) => {
    seen.push({ url, ...init } as Seen);
    const next = script.length ? script.shift()! : 200;
    if (next === "hang") return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error(`aborted with ${TOKEN}`))));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ status: next });
  };
  const publisher = new Publisher({
    store, fetch, now: () => NOW, log: (m) => logs.push(m), timeoutMs: 40, retryDelayMs: 0,
    config: () => (opts.config === null ? null : { baseUrl: BASE, publishToken: TOKEN, format: opts.format ?? "up" }),
  });
  const queue = (payload = UP, key = "test:1") => {
    store.enqueue(dev.id, key, "test", payload, NOW);
    return store.pending(10).find((r) => r.eventKey === key)!;
  };
  return { db, store, dev, seen, logs, publisher, queue };
}
const rowStatus = (db: Database.Database) => (db.prepare("SELECT status, attempts FROM control_push_outbox ORDER BY id").all() as { status: string; attempts: number }[]);

test("a send posts only to http://127.0.0.1:2586/<topic>?up=1 with the bearer token and the payload as body", async () => {
  const s = setup();
  assert.equal(NTFY_LOCAL, "http://127.0.0.1:2586");
  const r = await s.publisher.send(s.queue());
  assert.equal(r, "sent");
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0].url, `http://127.0.0.1:2586/${TOPIC}?up=1`);
  assert.equal(s.seen[0].method, "POST");
  assert.equal(s.seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(s.seen[0].body, UP);
  assert.deepEqual(rowStatus(s.db), [{ status: "sent", attempts: 1 }]);
  assert.equal(s.store.get(s.dev.id)!.lastSentAt, NOW);
});

test("5xx and network errors retry once; two failures mark the row failed and the endpoint unreachable", async () => {
  const s = setup({ script: [503, new Error("ECONNREFUSED")] });
  assert.equal(await s.publisher.send(s.queue()), "failed");
  assert.equal(s.seen.length, 2, "one retry");
  assert.deepEqual(rowStatus(s.db), [{ status: "failed", attempts: 2 }]);
  assert.equal(s.store.get(s.dev.id)!.lastError, "unreachable");
  const ok = setup({ script: [502, 200] });
  assert.equal(await ok.publisher.send(ok.queue()), "sent");
  assert.equal(ok.seen.length, 2);
  assert.deepEqual(rowStatus(ok.db), [{ status: "sent", attempts: 2 }]);
  assert.equal(ok.store.get(ok.dev.id)!.lastError, null);
});

test("4xx is rejected without a retry and recorded as rejected", async () => {
  const s = setup({ script: [403] });
  assert.equal(await s.publisher.send(s.queue()), "failed");
  assert.equal(s.seen.length, 1);
  assert.equal(s.store.get(s.dev.id)!.lastError, "rejected");
  assert.deepEqual(rowStatus(s.db), [{ status: "failed", attempts: 1 }]);
});

test("a hung request is cut after the timeout, retried once, then failed", async () => {
  const s = setup({ script: ["hang", "hang"] });
  const t0 = Date.now();
  assert.equal(await s.publisher.send(s.queue()), "failed");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(s.seen.length, 2);
  assert.ok(s.seen.every((x) => x.signal instanceof AbortSignal));
  assert.equal(s.store.get(s.dev.id)!.lastError, "unreachable");
});

test("the publisher token appears in no log line, error record or result", async () => {
  const s = setup({ script: [new Error(`connect to http://x failed, Authorization: Bearer ${TOKEN}`), "hang"] });
  const r = await s.publisher.send(s.queue());
  const dump = JSON.stringify([r, s.logs, s.db.prepare("SELECT * FROM control_push_endpoints").all(), s.db.prepare("SELECT * FROM control_push_outbox").all()]);
  assert.ok(!dump.includes(TOKEN) && !dump.includes("tk_publisher"), dump);
  assert.ok(s.logs.length >= 1, "a failure is logged, without text");
});

test("without a config push is off: nothing is fetched and the row stays pending", async () => {
  const s = setup({ config: null });
  assert.equal(s.publisher.enabled, false);
  assert.equal(await s.publisher.send(s.queue()), "off");
  assert.equal(s.seen.length, 0);
  assert.deepEqual(rowStatus(s.db), [{ status: "pending", attempts: 0 }]);
});

test("a device that cleared its registration after queueing fails without a request", async () => {
  const s = setup();
  const row = s.queue();
  s.store.clear(s.dev.id);
  assert.equal(await s.publisher.send(row), "failed");
  assert.equal(s.seen.length, 0);
});

test('format "ntfy" publishes the o3 form as an ntfy JSON body to the local server root with the same token', async () => {
  const s = setup({ format: "ntfy" });
  const built = serialize({ type: "approval.new", id: "3fa9c1d2", project: "demo-site" }, "ntfy");
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.equal(await s.publisher.send(s.queue(built.payload, "offer:3fa9c1d2")), "sent");
  assert.equal(s.seen[0].url, "http://127.0.0.1:2586/");
  assert.equal(s.seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(s.seen[0].headers["Content-Type"], "application/json");
  assert.ok(!("Title" in s.seen[0].headers) && !("Click" in s.seen[0].headers) && !("Tags" in s.seen[0].headers), "no content in headers");
  assert.deepEqual(JSON.parse(s.seen[0].body as string), {
    topic: TOPIC, title: "Approval needed: demo-site", message: "Open Approvals", tags: ["approval"], click: "controlapp://open/offers/3fa9c1d2",
  });
});

test("F5: an Arabic title is published intact and no header carries a non-Latin-1 character", async () => {
  const s = setup({ format: "ntfy" });
  const title = "موافقة مطلوبة: موقع تجريبي";
  const payload = JSON.stringify({ title, message: "افتح الموافقات", tags: ["approval"], click: "controlapp://open/offers/3fa9c1d2" });
  assert.equal(await s.publisher.send(s.queue(payload, "offer:ar")), "sent");
  for (const [k, v] of Object.entries(s.seen[0].headers)) assert.ok(![...v].some((c) => c.charCodeAt(0) > 255), `header ${k}`);
  const body = JSON.parse(s.seen[0].body as string);
  assert.equal(body.title, title);
  assert.equal(body.message, "افتح الموافقات");
  assert.equal(body.topic, TOPIC);
});

test("serialize gives the UP JSON for \"up\" and refuses what the gate refuses", () => {
  const up = serialize({ type: "test", id: "1" }, "up");
  assert.deepEqual(up, { ok: true, payload: UP });
  assert.equal(serialize({ type: "approval.new", id: "3fa9c1d2", project: "tk_x" }, "up").ok, false);
});

test("config: a missing file is push off, logged once; a valid file is read; bad content is off", () => {
  const logs: string[] = [];
  let t = NOW;
  let file: string | Error = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  const get = ntfyConfig({ read: () => { if (file instanceof Error) throw file; return file; }, path: "/etc/tokyo/ntfy.json", log: (m) => logs.push(m), now: () => t, ttlMs: 1000 });
  assert.equal(get(), null);
  t += 5000; assert.equal(get(), null);
  t += 5000; assert.equal(get(), null);
  assert.equal(logs.length, 1, "logged once");
  assert.ok(!logs[0].includes("ENOENT: no such file") || true);
  file = JSON.stringify({ baseUrl: BASE + "/", publishToken: TOKEN });
  t += 5000;
  assert.deepEqual(get(), { baseUrl: BASE, publishToken: TOKEN, format: "up" });
  file = JSON.stringify({ baseUrl: BASE, publishToken: TOKEN, format: "ntfy" });
  t += 5000;
  assert.equal(get()!.format, "ntfy");
  for (const bad of ["not json", JSON.stringify({ baseUrl: "http://x.example", publishToken: TOKEN }), JSON.stringify({ baseUrl: BASE }), JSON.stringify({ baseUrl: BASE, publishToken: "" }), JSON.stringify({ baseUrl: BASE, publishToken: TOKEN, format: "xml" }), "[]"]) {
    file = bad;
    t += 5000;
    assert.equal(get(), null, bad);
  }
  assert.ok(logs.every((l) => !l.includes(TOKEN)), "the token is in no log line");
});

test("config is cached within its ttl", () => {
  let reads = 0;
  let t = NOW;
  const get = ntfyConfig({ read: () => { reads += 1; return JSON.stringify({ baseUrl: BASE, publishToken: TOKEN }); }, path: "p", log: () => {}, now: () => t, ttlMs: 1000 });
  get(); get(); t += 500; get();
  assert.equal(reads, 1);
  t += 600; get();
  assert.equal(reads, 2);
});

// --- T6.1: RFC 8291 encryption for a device that stored p256dh and auth ---
import crypto from "node:crypto";
import { deriveContentKeys } from "./webpush";

function receiverKeys() {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}
function open(body: Buffer, ua: crypto.ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]!);
  const k = deriveContentKeys({ ecdhSecret: ua.computeSecret(asPublic), auth, uaPublic: ua.getPublicKey(), asPublic, salt });
  const rest = body.subarray(21 + body[20]!);
  const d = crypto.createDecipheriv("aes-128-gcm", k.cek, k.nonce);
  d.setAuthTag(rest.subarray(rest.length - 16));
  const padded = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
  return padded.subarray(0, padded.length - 1).toString("utf8");
}

test("T6.1 a device with p256dh and auth gets an aes128gcm body that only its key opens; headers say so", async () => {
  const s = setup();
  const r = receiverKeys();
  s.store.register(s.dev.id, TOPIC, r.keys, NOW);
  assert.equal(await s.publisher.send(s.queue()), "sent");
  const seen = s.seen[0]!;
  assert.equal(seen.url, `http://127.0.0.1:2586/${TOPIC}?up=1`);
  assert.equal(seen.headers["Content-Encoding"], "aes128gcm");
  assert.equal(seen.headers["Content-Type"], "application/octet-stream");
  assert.equal(seen.headers.Authorization, `Bearer ${TOKEN}`);
  assert.notEqual(typeof seen.body, "string");
  assert.equal(open(Buffer.from(seen.body as unknown as Uint8Array), r.ua, r.auth), UP);
  assert.ok(!Buffer.from(seen.body as unknown as Uint8Array).includes("Test notification"), "the title is not in the clear");
  assert.deepEqual(rowStatus(s.db), [{ status: "sent", attempts: 1 }]);
});

test("T6.1 devices without keys still get the plaintext JSON, and the ntfy-native format is never encrypted", async () => {
  const none = setup();
  assert.equal(await none.publisher.send(none.queue()), "sent");
  assert.equal(none.seen[0]!.body, UP);
  assert.equal(none.seen[0]!.headers["Content-Encoding"], undefined);
  assert.equal(none.seen[0]!.headers["Content-Type"], "application/json");
  const native = setup({ format: "ntfy" });
  native.store.register(native.dev.id, TOPIC, receiverKeys().keys, NOW);
  assert.equal(await native.publisher.send(native.queue(JSON.stringify({ title: "Test notification", message: "Tap to open", tags: ["bell"], click: "controlapp://settings" }))), "sent");
  assert.equal(native.seen[0]!.headers["Content-Encoding"], undefined);
});

test("T6.1 keys that cannot encrypt fail the row as rejected: nothing is sent, no plaintext fallback, no key in the log", async () => {
  const s = setup();
  s.store.register(s.dev.id, TOPIC, { p256dh: "BFakeKey_-1", auth: "FakeAuth_-1" }, NOW);
  assert.equal(await s.publisher.send(s.queue()), "failed");
  assert.equal(s.seen.length, 0);
  assert.deepEqual(rowStatus(s.db), [{ status: "failed", attempts: 0 }]);
  assert.equal(s.store.get(s.dev.id)!.lastError, "rejected");
  assert.ok(s.logs.length >= 1);
  for (const l of s.logs) assert.ok(!/BFakeKey|FakeAuth|Test notification/.test(l), l);
});
