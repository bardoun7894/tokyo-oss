import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { auditParams, errorCodeFor, scrubJson } from "./gateway";

interface Seen { method: string; url: string; body: unknown; headers: Record<string, unknown> }
type Responder = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;

/** A control app whose dashboard is a spy: it records what reaches it and answers with `responder`. */
async function setup(caps: Cap[] = ["life:read", "life:write"], responder: Responder = (_req, res) => { res.json({ ok: true }); }) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const seen: Seen[] = [];
  const clock = { t: Date.parse("2026-10-17T12:00:00Z") };
  const state = { responder };
  const dashboard = express.Router();
  dashboard.use((req, res, next) => { seen.push({ method: req.method, url: req.url, body: req.body, headers: { ...req.headers } }); return state.responder(req, res, next); });
  const t = await controlApp({ life: { dashboard, ops, now: () => clock.t } as any }, db);
  const dev = t.store.listDevices()[0]!;
  t.store.setCaps(dev.id, caps);
  const call = (method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => t.srv.call(method, "/control-api/v1/life/api" + p, body, { ...t.auth, ...extra });
  const audit = () => db.prepare("SELECT action, subject, params, result, idem_key, device_id FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; params: string; result: string; idem_key: string | null; device_id: string }[];
  return { ...t, db, ops, seen, clock, state, dev, call, audit };
}

test("an unlisted method and path pair is 404 in the control envelope and never reaches the dashboard handler, even with every cap", async () => {
  const t = await setup(["ops:read", "ops:write", "ops:service", "life:read", "life:write", "agents:start", "ops:run"]);
  const pairs: [string, string][] = [
    ["POST", "/settings/kie-key"], ["POST", "/auth/password"], ["POST", "/auth/login"], ["POST", "/whatsapp/connect"], ["POST", "/groupchat/open"],
    ["GET", "/clients"], ["GET", "/internal/status"], ["POST", "/internal/actions/x1"], ["GET", "/nope"], ["GET", "/"], ["GET", ""],
    ["PUT", "/tasks"], ["DELETE", "/overview"], ["GET", "/overview/"], ["GET", "/Overview"], ["HEAD", "/overview"], ["OPTIONS", "/overview"],
    ["POST", "/tasks/../complete"], ["POST", "/tasks/a%2Fb/complete"], ["GET", "/calendar/2026-10-17/extra"],
  ];
  for (const [method, p] of pairs) {
    const r = await t.call(method, p, method === "POST" ? {} : undefined, { "idempotency-key": "k-" + Math.random().toString(36).slice(2) });
    assert.equal(r.status, 404, `${method} ${p}`);
    if (method !== "HEAD") assert.deepEqual(r.json, { error: { code: "not_found", message: "Not found" } }, `${method} ${p}`);
  }
  assert.equal(t.seen.length, 0, "no handler call");
  assert.equal(t.audit().length, 0, "nothing audited");
  await t.close();
});

test("GET needs life:read and every other method needs life:write: 403 forbidden, and the handler is not called", async () => {
  const w = await setup(["life:write"]);
  const read = await w.call("GET", "/overview");
  assert.equal(read.status, 403);
  assert.equal(read.json.error.code, "forbidden");
  assert.equal((await w.call("POST", "/tasks", { title: "x" }, { "idempotency-key": "a1" })).status, 200);
  assert.equal(w.seen.length, 1);
  await w.close();

  const r = await setup(["life:read"]);
  assert.equal((await r.call("GET", "/overview")).status, 200);
  for (const [m, p] of [["POST", "/tasks"], ["DELETE", "/tasks/5"], ["PATCH", "/obligations/3"], ["POST", "/settings/model"]] as const) {
    const w2 = await r.call(m, p, m === "DELETE" ? undefined : {}, { "idempotency-key": "k" + p.length });
    assert.equal(w2.status, 403, `${m} ${p}`);
    assert.equal(w2.json.error.code, "forbidden");
  }
  assert.equal(r.seen.length, 1, "only the read got through");
  await r.close();

  const none = await setup(["ops:read"]);
  assert.equal((await none.call("GET", "/overview")).status, 403);
  assert.equal(none.seen.length, 0);
  await none.close();
});

test("a request with no bearer token is 401 and never reaches the gateway", async () => {
  const t = await setup();
  const r = await t.srv.call("GET", "/control-api/v1/life/api/overview");
  assert.equal(r.status, 401);
  assert.equal(t.seen.length, 0);
  await t.close();
});

test("the dashboard receives the dashboard path with its query and body, and no Authorization header", async () => {
  const t = await setup();
  await t.call("GET", "/habits/history?days=7");
  await t.call("POST", "/tasks/12/edit", { title: "T", priority: "high" }, { "idempotency-key": "e1" });
  assert.equal(t.seen[0].method, "GET");
  assert.equal(t.seen[0].url, "/api/habits/history?days=7");
  assert.equal(t.seen[1].url, "/api/tasks/12/edit");
  assert.deepEqual(t.seen[1].body, { title: "T", priority: "high" });
  for (const s of t.seen) assert.equal(s.headers.authorization, undefined, "the bearer is the gateway's, not the dashboard's");
  await t.close();
});

test("a dashboard router that does not answer is a 404 envelope; a throw is 500 unavailable", async () => {
  const t = await setup(undefined, (_req, _res, next) => next());
  const r = await t.call("GET", "/overview");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "not_found");
  t.state.responder = () => { throw new Error("boom /root/tokyo/secret.ts"); };
  const e = await t.call("GET", "/goals");
  assert.equal(e.status, 500);
  assert.deepEqual(e.json, { error: { code: "unavailable", message: "Internal error" } });
  await t.close();
});

test("writes need an Idempotency-Key: missing or malformed is 400 before the handler", async () => {
  const t = await setup();
  const none = await t.call("POST", "/tasks", { title: "x" });
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, "bad_request");
  assert.match(none.json.error.message, /Idempotency-Key/);
  for (const bad of ["", "a b", "x".repeat(129), "k/1", "k;1"]) assert.equal((await t.call("POST", "/tasks", {}, { "idempotency-key": bad })).status, 400, JSON.stringify(bad));
  assert.equal(t.seen.length, 0);
  assert.equal((await t.call("GET", "/overview")).status, 200, "reads need no key");
  await t.close();
});

test("a replayed Idempotency-Key returns the stored status and body without a second handler call", async () => {
  let n = 0;
  const t = await setup(undefined, (_req, res) => { n += 1; res.status(201).json({ ok: true, id: 100 + n }); });
  const first = await t.call("POST", "/tasks", { title: "milk" }, { "idempotency-key": "k-1" });
  assert.deepEqual([first.status, first.json], [201, { ok: true, id: 101 }]);
  const again = await t.call("POST", "/tasks", { title: "milk" }, { "idempotency-key": "k-1" });
  assert.deepEqual([again.status, again.json], [201, { ok: true, id: 101 }]);
  assert.equal(again.headers["idempotent-replay"], "true");
  assert.equal(n, 1, "the handler ran once");
  const other = await t.call("POST", "/tasks", { title: "milk" }, { "idempotency-key": "k-2" });
  assert.equal(other.json.id, 102, "a new key is a new write");
  assert.equal(t.audit().filter((a) => a.idem_key === "k-1").length, 1);
  await t.close();
});

test("the same key for another path or another body of the same route is a 409 conflict and runs nothing", async () => {
  const t = await setup();
  await t.call("POST", "/tasks/1/complete", {}, { "idempotency-key": "k-1" });
  const path = await t.call("POST", "/tasks/2/complete", {}, { "idempotency-key": "k-1" });
  assert.equal(path.status, 409);
  assert.equal(path.json.error.code, "conflict");
  await t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-2" });
  const body = await t.call("POST", "/tasks", { title: "b" }, { "idempotency-key": "k-2" });
  assert.equal(body.status, 409);
  assert.equal(t.seen.length, 2);
  // The key is namespaced by route, so the same string on another route is a different key and works.
  assert.equal((await t.call("POST", "/goals", { title: "a" }, { "idempotency-key": "k-9" })).status, 200);
  assert.equal((await t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-9" })).status, 200);
  await t.close();
});

test("a replay by another device is a 409, not the first device's reply", async () => {
  const t = await setup();
  await t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-1" });
  const login = await t.srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "second" });
  const dev2 = t.store.listDevices().find((d) => d.name === "second")!;
  t.store.setCaps(dev2.id, ["life:read", "life:write"]);
  const r = await t.srv.call("POST", "/control-api/v1/life/api/tasks", { title: "a" }, { authorization: `Bearer ${login.json.deviceToken}`, "idempotency-key": "k-1" });
  assert.equal(r.status, 409);
  assert.equal(t.seen.length, 1);
  await t.close();
});

test("a failed write is not stored: the same key reaches the handler again", async () => {
  let n = 0;
  const t = await setup(undefined, (_req, res) => { n += 1; if (n === 1) { res.status(500).json({ error: "Failed to add task" }); return; } res.json({ ok: true }); });
  const bad = await t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-1" });
  assert.equal(bad.status, 500);
  const ok = await t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-1" });
  assert.equal(ok.status, 200);
  assert.equal(n, 2);
  const rows = t.audit();
  assert.deepEqual(rows.map((r) => r.result), ["error:500", "ok"]);
  await t.close();
});

test("two requests with one key at the same time: the second is a 409 while the first runs", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const t = await setup(undefined, async (_req, res) => { await gate; res.json({ ok: true }); });
  const first = t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-1" });
  await new Promise((r) => setTimeout(r, 50));
  const second = await t.call("POST", "/tasks", { title: "a" }, { "idempotency-key": "k-1" });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(t.seen.length, 1);
  await t.close();
});

test("each write is audited as life.<METHOD>.<row id> with redacted params; a read is not audited", async () => {
  const t = await setup();
  await t.call("GET", "/overview");
  assert.equal(t.audit().length, 0);
  await t.call("POST", "/tasks/12/complete", {}, { "idempotency-key": "k-1" });
  await t.call("DELETE", "/obligations/payments/9", undefined, { "idempotency-key": "k-2" });
  await t.call("POST", "/whatsapp/send", { jid: "212600000000@s.whatsapp.net", text: "hello secret message", amount: 4500 }, { "idempotency-key": "k-3" });
  const rows = t.audit();
  assert.deepEqual(rows.map((r) => [r.action, r.subject.split("#")[0], r.result]), [
    ["life.POST.L43", "/tasks/12/complete", "ok"],
    ["life.DELETE.L64", "/obligations/payments/9", "ok"],
    ["life.POST.L93", "/whatsapp/send", "ok"],
  ]);
  for (const r of rows) assert.equal(r.device_id, t.dev.id);
  assert.ok(!rows[2].params.includes("hello secret message") && !rows[2].params.includes("4500") && !rows[2].params.includes("212600000000"), rows[2].params);
  assert.ok(!rows.map((r) => r.subject).join().includes("secret"));
  await t.close();
});

test("auditParams keeps field names and a few plain enum values, and drops text, amounts, ids lists and anything secret", () => {
  const p = JSON.parse(auditParams({ title: "buy milk", text: "hello", message: "hi", amount: 4500, price: 12, priority: "high", category: "home", ids: [1, 2, 3], key: "PROFILE_NAME", value: "The owner", confirm: true, note: "tk_abcdef0123456789abcdef", jid: "212600000000@s.whatsapp.net" }));
  assert.deepEqual(p.values, { priority: "high", category: "home", key: "PROFILE_NAME", confirm: true });
  assert.deepEqual(p.counts, { ids: 3 });
  assert.deepEqual([...p.fields].sort(), ["amount", "category", "confirm", "ids", "jid", "key", "message", "note", "price", "priority", "text", "title", "value"]);
  const flat = JSON.stringify(p);
  for (const leak of ["buy milk", "hello", "4500", "The owner", "tk_abcdef", "212600000000"]) assert.ok(!flat.includes(leak), leak);
  assert.deepEqual(JSON.parse(auditParams(undefined)), { fields: [] });
  assert.deepEqual(JSON.parse(auditParams("raw")), { fields: [] });
  assert.deepEqual(JSON.parse(auditParams([1, 2])), { fields: [] });
  assert.equal(JSON.parse(auditParams({ priority: "x".repeat(100), type: "a b" })).values, undefined, "long or odd values are dropped");
});

test("writes are limited to 30 per minute and paid writes to 5 per 10 minutes, per device", async () => {
  const t = await setup();
  for (let i = 0; i < 30; i++) assert.equal((await t.call("POST", "/tasks", { title: "x" }, { "idempotency-key": "w" + i })).status, 200, "write " + i);
  const over = await t.call("POST", "/tasks", { title: "x" }, { "idempotency-key": "w30" });
  assert.equal(over.status, 429);
  assert.equal(over.json.error.code, "rate_limited");
  assert.ok(Number(over.headers["retry-after"]) > 0);
  assert.equal(t.seen.length, 30);
  assert.equal((await t.call("GET", "/overview")).status, 200, "reads are not write-limited");
  const replay = await t.call("POST", "/tasks", { title: "x" }, { "idempotency-key": "w0" });
  assert.equal(replay.status, 200, "a replay costs nothing and is answered even over the limit");
  t.clock.t += 61_000;
  assert.equal((await t.call("POST", "/tasks", { title: "x" }, { "idempotency-key": "w31" })).status, 200, "the window passed");
  await t.close();

  const p = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await p.call("POST", "/chat-analyzer/classify", {}, { "idempotency-key": "p" + i })).status, 200, "paid " + i);
  const sixth = await p.call("POST", "/transcripts/7/transcribe", {}, { "idempotency-key": "p5" });
  assert.equal(sixth.status, 429, "any paid row shares the paid window");
  assert.equal(sixth.json.error.code, "rate_limited");
  assert.equal((await p.call("POST", "/tasks", { title: "x" }, { "idempotency-key": "p6" })).status, 200, "a normal write is still fine");
  p.clock.t += 9 * 60_000;
  assert.equal((await p.call("POST", "/instagram/test", {}, { "idempotency-key": "p7" })).status, 429);
  p.clock.t += 2 * 60_000;
  assert.equal((await p.call("POST", "/instagram/test", {}, { "idempotency-key": "p8" })).status, 200);
  await p.close();
});

test("{error} bodies become the control envelope with a mapped code; the message is scrubbed", async () => {
  const t = await setup();
  const cases: [number, string][] = [
    [400, "bad_request"], [401, "unavailable"], [403, "forbidden"], [404, "not_found"], [409, "conflict"], [413, "bad_request"], [422, "bad_request"],
    [429, "rate_limited"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"], [418, "bad_request"],
  ];
  for (const [status, code] of cases) {
    t.state.responder = (_req, res) => { res.status(status).json({ error: `Failed at /root/tokyo/src/x.ts with Bearer abc123def` }); };
    const r = await t.call("GET", "/goals");
    assert.equal(r.status, status);
    assert.equal(r.json.error.code, code, String(status));
    assert.equal(r.json.error.message, "Failed at ... with Bearer [redacted]");
    assert.deepEqual(Object.keys(r.json), ["error"]);
  }
  t.state.responder = (_req, res) => { res.status(400).json({ error: "x".repeat(500) }); };
  assert.ok((await t.call("GET", "/goals")).json.error.message.length <= 200);
  t.state.responder = (_req, res) => { res.status(400).json({ message: "no error field" }); };
  const odd = await t.call("GET", "/goals");
  assert.equal(odd.json.error.code, "bad_request");
  t.state.responder = (_req, res) => { res.status(204).end(); };
  assert.equal((await t.call("POST", "/tasks/3/start", {}, { "idempotency-key": "n1" })).status, 204);
  await t.close();
});

test("errorCodeFor maps a dashboard status", () => {
  assert.deepEqual([400, 401, 403, 404, 409, 429, 500, 504, 418].map(errorCodeFor), ["bad_request", "unavailable", "forbidden", "not_found", "conflict", "rate_limited", "unavailable", "unavailable", "bad_request"]);
});

test("JSON replies lose absolute path runs; relative media keys, numbers, nulls and keys stay", async () => {
  const body = {
    file: "/root/tokyo/data/audit.json", nested: [{ p: "see /home/tokyo-agent/x/y and more" }], media: "whatsapp-media/abc.jpg", thumb: "gallery/2026/a.jpg",
    n: 5, t: null, b: false, url: "https://example.com/a/b/c", rel: "a/b/c", "/root/tokyo/key": "k", list: ["/var/lib/docker/x", "ok"], lone: "/etc",
  };
  const t = await setup(undefined, (_req, res) => { res.json(body); });
  const r = await t.call("GET", "/overview");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    file: "...", nested: [{ p: "see [path] and more" }], media: "whatsapp-media/abc.jpg", thumb: "gallery/2026/a.jpg",
    n: 5, t: null, b: false, url: "https://example.com/a/b/c", rel: "a/b/c", "/root/tokyo/key": "k", list: ["...", "ok"], lone: "/etc",
  });
  assert.ok(!JSON.stringify(r.json).includes("/root/tokyo/data"));
  await t.close();
});

test("scrubJson also removes the path of an scp-style git remote, and leaves urls and short tails alone", () => {
  assert.deepEqual(scrubJson({ a: "root@myhost:/root/code/app.git", b: "MyHost:/root/code/app-x", c: "https://github.com/org/repo.git", d: "ssh://git@github.com/org/repo.git", e: "host:/only", f: "at 10:30/day", g: "C:/Users/a/b" }), {
    a: "root@myhost:...", b: "MyHost:...", c: "https://github.com/org/repo.git", d: "ssh://git@github.com/org/repo.git", e: "host:/only", f: "at 10:30/day", g: "C:...",
  });
});

test("scrubJson leaves data urls and base64 runs alone, and still scrubs a path next to them", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg+/a/b/c==";
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/";
  const raw = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/";
  assert.deepEqual(scrubJson({ qrDataUrl: png, img: jpeg, raw, plus: "+/a/b", run: "QUJD+/ab/cd+/ef", note: "see /root/app/data and " + raw.slice(0, 50) }), {
    qrDataUrl: png, img: jpeg, raw, plus: "+/a/b", run: "QUJD+/ab/cd+/ef", note: "see ... and " + raw.slice(0, 50),
  });
  assert.equal(scrubJson("/root/Projects/FooBar123/node_modules/x"), "...");
});

test("scrubJson keeps shapes and does not mutate its input", () => {
  const input = { a: ["/usr/lib/x/y", { b: "/srv/app/z" }], c: 1 };
  const out = scrubJson(input);
  assert.deepEqual(out, { a: ["...", { b: "..." }], c: 1 });
  assert.equal(input.a[0], "/usr/lib/x/y");
  assert.equal(scrubJson("/a/b"), "...");
  assert.equal(scrubJson(null), null);
  assert.deepEqual(scrubJson([]), []);
});

test("POST /settings is checked against the key allowlist before the handler: excluded 403, unknown or missing 400, safe and sheet keys pass", async () => {
  const t = await setup();
  let k = 0;
  const post = (body: unknown) => t.call("POST", "/settings", body, { "idempotency-key": "s" + k++ });
  for (const key of ["JOBHUNT_DRY_RUN", "JOBHUNT_DAILY_CAP", "JOBHUNT_AUTOSEND_SCORE"]) {
    const r = await post({ key, value: "0" });
    assert.equal(r.status, 403, key);
    assert.equal(r.json.error.code, "forbidden");
  }
  for (const body of [{ key: "NOPE", value: "1" }, { key: "constructor", value: "1" }, { value: "1" }, { key: 5 }, {}, "x"]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal(t.seen.length, 0, "none of those reached the handler");
  for (const key of ["PROFILE_NAME", "MODULE_TASKS", "WA_AUTO_REPLIES", "SHOP_PRICE_MULTIPLIER"]) assert.equal((await post({ key, value: null })).status, 200, key);
  assert.equal(t.seen.length, 4);
  assert.ok(t.audit().every((a) => a.action === "life.POST.L97"));
  await t.close();
});

test("F3: L30 /whatsapp/status never carries qrDataUrl or pairingCode, and string values are redacted", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
  const t = await setup(["life:read"], (_req, res) => {
    res.json({ status: "connecting", qrDataUrl: png, pairingCode: "ABCD-EFGH", user: { id: "x", note: "Authorization Bearer abcDEF123456.tok" }, nested: [{ pairingCode: "1234-5678", ok: 1 }] });
  });
  const r = await t.call("GET", "/whatsapp/status");
  assert.equal(r.status, 200);
  const s = JSON.stringify(r.json);
  assert.ok(!/qrDataUrl|pairingCode|ABCD-EFGH|1234-5678|data:image/.test(s), s);
  assert.ok(!s.includes("abcDEF123456"), s);
  assert.deepEqual(r.json.status, "connecting");
  assert.equal(r.json.user.id, "x");
  await t.close();
});

test("F3: other life replies redact secret-looking strings but keep data urls intact", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
  const t = await setup(["life:read"], (_req, res) => { res.json({ img: png, leak: "KIE_API_KEY=abcd1234efgh", sk: "sk-abcdefghijklmnopqrstuvwx" }); });
  const r = await t.call("GET", "/overview");
  assert.equal(r.json.img, png);
  assert.ok(!JSON.stringify(r.json).includes("abcd1234efgh"));
  assert.ok(!JSON.stringify(r.json).includes("sk-abcdefghijklmnopqrstuvwx"));
  await t.close();
});
