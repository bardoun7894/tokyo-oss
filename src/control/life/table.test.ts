import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Scratch db so ../../settings never opens life.db.
process.env.TOKYO_DB_PATH = path.join(os.tmpdir(), `tokyo-life-table-${process.pid}.db`);
test.after(() => { for (const s of ["", "-wal", "-shm"]) try { fs.unlinkSync(process.env.TOKYO_DB_PATH! + s); } catch { /* absent */ } });

import { SETTINGS } from "../../settings";
import { CAPS } from "../store";
import { LIFE_ROWS, matchLife, settingKeyClass, SETTINGS_KEYS, type LifeRow } from "./table";

const ROOT = process.cwd();
const FROZEN = fs.readFileSync(path.join(ROOT, "specs", "012-full-control", "research-life.md"), "utf8");

/** The frozen table of research-life.md as rows of cells. */
function frozenRows(): string[][] {
  return FROZEN.split("\n").filter((l) => /^\| L\d+ \|/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, "")));
}

/** A concrete path for a pattern: every `:param` becomes a plain value. */
const concrete = (pattern: string): string => pattern.replace(/:[A-Za-z]+/g, "x1");

test("every row has method, path pattern, cap, confirm class, paid flag, body limit and rate class", () => {
  assert.equal(LIFE_ROWS.length, 99);
  const ids = new Set<string>();
  for (const r of LIFE_ROWS) {
    assert.match(r.id, /^L\d+$/);
    assert.ok(!ids.has(r.id), "unique " + r.id);
    ids.add(r.id);
    assert.ok(["GET", "POST", "PATCH", "DELETE"].includes(r.method), r.id);
    assert.match(r.pattern, /^\/[a-z0-9\-/:A-Za-z]+$/, r.id);
    assert.ok(!r.pattern.endsWith("/"), r.id);
    assert.equal(r.cap, r.method === "GET" ? "life:read" : "life:write", r.id);
    assert.ok((CAPS as readonly string[]).includes(r.cap), r.id);
    assert.ok(r.confirm === "none" || r.confirm === "CS", r.id);
    assert.equal(typeof r.paid, "boolean", r.id);
    assert.ok(["R", "W", "P", "B"].includes(r.rate), r.id);
    assert.ok(Number.isInteger(r.bodyLimit) && r.bodyLimit >= 0, r.id);
    assert.equal(r.bodyLimit === 0, r.method === "GET", "only reads have no body: " + r.id);
    assert.equal(r.rate === "R", r.method === "GET", "reads are R: " + r.id);
    assert.equal(r.paid, r.rate === "P", "paid rows are the P class: " + r.id);
  }
  assert.equal(LIFE_ROWS.filter((r) => r.method === "GET").length, 41);
  assert.equal(LIFE_ROWS.filter((r) => r.method !== "GET").length, 58);
  assert.equal(LIFE_ROWS.filter((r) => r.confirm === "CS").length, 24);
  assert.deepEqual(LIFE_ROWS.filter((r) => r.paid).map((r) => r.id), ["L79", "L92", "L94", "L95", "L96"]);
});

test("the table is exactly the frozen table of research-life.md, row by row", () => {
  const frozen = frozenRows();
  assert.equal(frozen.length, 99);
  const sizeOf = (cell: string): number => {
    if (cell === "64k") return 64 * 1024;
    if (cell === "-") return 0;
    const m = /^raw (\d+) MB/.exec(cell);
    assert.ok(m, "body cell " + cell);
    return Number(m![1]) * 1024 * 1024;
  };
  frozen.forEach(([id, method, pattern, cap, confirm, paid, body, rate], i) => {
    const r = LIFE_ROWS[i];
    assert.deepEqual([r.id, r.method, r.pattern, r.cap, r.confirm, r.paid, r.bodyLimit, r.rate], [id, method, pattern, cap, confirm, paid === "yes", sizeOf(body), rate], id);
  });
});

test("excluded routes never match, with any method, and neither do dashboard-only paths", () => {
  const excluded = [
    "/settings/kie-key", "/auth/password", "/auth/login", "/whatsapp/connect", "/groupchat/open",
    "/clients", "/report/latest", "/progress/week", "/journals", "/shop/ai-context",
    "/internal/status", "/internal/actions/x1", "/login", "/", "/favicon.ico", "/anything-else", "/groupchat", "/groupchat/messages",
  ];
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    for (const p of excluded) assert.equal(matchLife(method, p), null, `${method} ${p}`);
  }
});

test("near misses do not match: other method, trailing slash, case, extra or missing segment, empty or dot param, encoded slash", () => {
  assert.equal(matchLife("DELETE", "/overview"), null);
  assert.equal(matchLife("POST", "/overview"), null);
  assert.equal(matchLife("GET", "/overview/"), null);
  assert.equal(matchLife("GET", "/Overview"), null);
  assert.equal(matchLife("GET", "/overview/x"), null);
  assert.equal(matchLife("GET", "/tasks/x1/complete"), null, "GET on a POST-only path");
  assert.equal(matchLife("POST", "/tasks//complete"), null);
  assert.equal(matchLife("POST", "/tasks/../complete"), null);
  assert.equal(matchLife("POST", "/tasks/./complete"), null);
  assert.equal(matchLife("POST", "/tasks/a%2Fb/complete"), null);
  for (const bad of ["%2e%2e", "%2E", "%2e.", ".%2e", "a%5Cb", "a%5cb", "a%00b", "a%2fb", "a%zzb", "a%4", "a%"]) assert.equal(matchLife("POST", `/tasks/${bad}/complete`), null, bad);
  assert.equal(matchLife("POST", "/tasks/a/b/complete"), null);
  assert.equal(matchLife("GET", "/calendar/2026-10-17/extra"), null);
  assert.equal(matchLife("POST", "/settings/kie-key"), null);
  assert.equal(matchLife("get", "/overview"), null, "methods are matched exactly");
  assert.equal(matchLife("GET", "overview"), null);
  assert.equal(matchLife("GET", "/overview?x=1"), null, "the query is not part of the path");
});

test("static segments win over a parameter: /whatsapp/media/chats is L26, /whatsapp/media/delete is L86", () => {
  assert.equal(matchLife("GET", "/whatsapp/media/chats")?.id, "L26");
  assert.equal(matchLife("POST", "/whatsapp/media/delete")?.id, "L86");
  assert.equal(matchLife("GET", "/calendar")?.id, "L6");
  assert.equal(matchLife("GET", "/calendar/2026-10-17")?.id, "L7");
  assert.equal(matchLife("POST", "/obligations/payments/x1")?.id, undefined, "POST has no payments row; only DELETE does");
  assert.equal(matchLife("DELETE", "/obligations/payments/12")?.id, "L64");
  assert.equal(matchLife("DELETE", "/obligations/12")?.id, "L65");
  assert.equal(matchLife("GET", "/products/batches")?.id, "L18");
  assert.equal(matchLife("GET", "/products/batches/b1")?.id, "L19");
  assert.equal(matchLife("POST", "/project-repos/sync")?.id, "L73", "the literal row, not :id");
  assert.equal(matchLife("POST", "/project-repos/7")?.id, "L74");
  assert.equal(matchLife("POST", "/settings/model")?.id, "L99");
});

test("a path with a parameter value never matches a row with fewer segments to bind: the concrete path of each row resolves to that row", () => {
  for (const r of LIFE_ROWS) {
    assert.equal(matchLife(r.method, concrete(r.pattern))?.id, r.id, `${r.method} ${r.pattern}`);
    if (!r.pattern.includes(":")) continue; // literal rows are checked for overlaps below
    const hits = LIFE_ROWS.filter((o) => o.method === r.method && matches(o, concrete(r.pattern)));
    assert.deepEqual(hits.map((h) => h.id), [r.id], `no other row of the same method claims it: ${r.method} ${r.pattern}`);
  }
  // The only overlap is a literal row inside a parameter row (`sync` inside `:id`); the literal one is chosen above.
  const overlaps: string[] = [];
  for (const r of LIFE_ROWS) {
    if (r.pattern.includes(":")) continue;
    for (const o of LIFE_ROWS) if (o !== r && o.method === r.method && matches(o, r.pattern)) overlaps.push(`${r.id}>${o.id}`);
  }
  assert.deepEqual(overlaps, ["L73>L74"]);
});
const matches = (row: LifeRow, p: string): boolean => row.regex.test(p);

test("every sample's path matches its own row, and only that row", () => {
  const dir = path.join(ROOT, "test-fixtures", "life");
  const files = fs.readdirSync(dir).filter((f) => /^L\d+\.json$/.test(f));
  assert.equal(files.length, 41);
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { id: string; method: string; path: string };
    const row = LIFE_ROWS.find((r) => r.id === s.id);
    assert.ok(row, s.id);
    assert.equal(row!.pattern, s.path, s.id);
    assert.equal(row!.method, s.method, s.id);
    assert.equal(matchLife(s.method, concrete(s.path))?.id, s.id, s.id);
  }
});

test("path parameters are captured", () => {
  const m = matchLife("GET", "/whatsapp/messages/212600000000@s.whatsapp.net");
  assert.equal(m?.id, "L32");
  assert.equal(matchLife("GET", "/whatsapp/messages/212600000000%40s.whatsapp.net")?.id, "L32", "a jid sent percent-encoded");
  assert.equal(matchLife("GET", "/whatsapp/messages/1203%40g.us")?.id, "L32");
  assert.equal(matchLife("POST", "/tasks/a%20b/complete")?.id, "L43", "an escaped space is just a character");
  assert.equal(matchLife("POST", "/adhkar/morning")?.id, "L66");
  assert.equal(matchLife("GET", "/media/gallery-1.jpg")?.id, "L8");
});

test("POST /settings carries the key allowlist: 26 safe, 4 with a confirm sheet, 3 excluded, and the table covers every live key once", () => {
  const row = LIFE_ROWS.find((r) => r.id === "L97")!;
  assert.deepEqual([row.method, row.pattern], ["POST", "/settings"]);
  assert.equal(row.settingsKeys, SETTINGS_KEYS);
  assert.equal(SETTINGS_KEYS.safe.length, 26);
  assert.deepEqual([...SETTINGS_KEYS.confirm], ["TRANSCRIBE_ENABLED", "WA_AUTO_REPLIES", "SHOP_AI_REPLIES", "SHOP_PRICE_MULTIPLIER"]);
  assert.deepEqual([...SETTINGS_KEYS.excluded], ["JOBHUNT_DRY_RUN", "JOBHUNT_DAILY_CAP", "JOBHUNT_AUTOSEND_SCORE"]);
  const all = [...SETTINGS_KEYS.safe, ...SETTINGS_KEYS.confirm, ...SETTINGS_KEYS.excluded];
  assert.equal(new Set(all).size, all.length, "no key in two lists");
  assert.deepEqual([...all].sort(), SETTINGS.map((s) => s.key).sort(), "a new live setting must be classified here before the app can write it");
  for (const k of SETTINGS_KEYS.safe) assert.equal(settingKeyClass(k), "safe", k);
  for (const k of SETTINGS_KEYS.confirm) assert.equal(settingKeyClass(k), "confirm", k);
  for (const k of SETTINGS_KEYS.excluded) assert.equal(settingKeyClass(k), "excluded", k);
  for (const k of ["JOBHUNT_DRY_RUN", "NOPE", "", "profile_name", "constructor", "__proto__", "toString"]) assert.notEqual(settingKeyClass(k), "safe", k);
  assert.equal(settingKeyClass("NOPE"), "unknown");
  assert.equal(settingKeyClass("constructor"), "unknown");
  for (const r of LIFE_ROWS) if (r.id !== "L97") assert.equal(r.settingsKeys, undefined, r.id);
});
