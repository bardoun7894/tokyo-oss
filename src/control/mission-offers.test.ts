import { test } from "node:test";
import assert from "node:assert/strict";
import type { MissionRow } from "../mission-store";
import { controlApp } from "./test-app";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const TTL = 30 * 60_000;

const mission = (id: string, over: Partial<MissionRow> = {}): MissionRow => ({
  id, project: "tokyo", prompt: "add dark mode", sender: "owner (control app)", jid: "", state: "proposed", engine: "claude",
  answered_by: null, answered_at: null, branch: null, base_commit: null, clone_path: null, tmux_session: null, exit_code: null,
  result: null, test_output: null, deploy_output: null, hold_reason: null, created_at: T0, updated_at: T0, expires_at: T0 + TTL, ...over,
});

// A fake approval store with the same exactly-once rule as answerMission.
async function setup() {
  let t = T0;
  const rows = new Map<string, MissionRow>();
  const answered: any[] = [];
  const app = await controlApp({
    offers: {
      now: () => t,
      listActions: () => [],
      listDeploys: () => [],
      answerAction: async () => ({ status: "missing" }),
      answerDeploy: async () => ({ status: "missing" }),
      listMissions: () => [...rows.values()],
      answerMission: async (id, answer, channel) => {
        const m = rows.get(id);
        if (!m) return { status: "missing" };
        if (m.state === "proposed" && t >= m.expires_at) return { status: "expired" };
        if (m.state !== "proposed") return { status: "already", mission: m };
        m.state = answer === "approve" ? "approved" : "declined";
        m.answered_by = channel;
        m.answered_at = t;
        answered.push({ id, answer, channel });
        return { status: "applied", mission: m, reply: `Mission ${id} ${m.state}.` };
      },
    },
  });
  return { ...app, rows, answered, advance: (ms: number) => (t += ms) };
}

test("a proposed mission is a pending kind:mission offer with approve and skip, id and missionId set", async () => {
  const s = await setup();
  s.rows.set("4f2a9c1b", mission("4f2a9c1b"));
  const r = await s.get("/offers");
  assert.equal(r.status, 200);
  assert.equal(r.json.offers.length, 1);
  const o = r.json.offers[0];
  assert.equal(o.kind, "mission");
  assert.equal(o.id, "4f2a9c1b");
  assert.equal(o.missionId, "4f2a9c1b");
  assert.equal(o.project, "tokyo");
  assert.equal(o.state, "pending");
  assert.match(o.body, /add dark mode/);
  assert.deepEqual(o.buttons, [{ id: "approve", label: "Approve" }, { id: "skip", label: "Skip" }]);
  assert.equal(o.channel, null);
  await s.close();
});

test("approve takes the approval path once with channel app; a second answer is 409", async () => {
  const s = await setup();
  s.rows.set("4f2a9c1b", mission("4f2a9c1b"));
  const a = await s.post("/offers/4f2a9c1b/answer", { button: "approve" });
  assert.equal(a.status, 200);
  assert.equal(a.json.offer.state, "approved");
  assert.equal(a.json.offer.answeredButton, "approve");
  assert.equal(a.json.offer.channel, "app");
  assert.deepEqual(s.answered, [{ id: "4f2a9c1b", answer: "approve", channel: "app" }]);
  const again = await s.post("/offers/4f2a9c1b/answer", { button: "skip" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "already");
  assert.equal(again.json.answeredBy.channel, "app");
  assert.equal(s.answered.length, 1);
  await s.close();
});

test("skip runs the reject path and reads as declined", async () => {
  const s = await setup();
  s.rows.set("aaaaaaaa", mission("aaaaaaaa"));
  const a = await s.post("/offers/aaaaaaaa/answer", { button: "skip" });
  assert.equal(a.status, 200);
  assert.equal(a.json.offer.state, "declined");
  assert.deepEqual(s.answered, [{ id: "aaaaaaaa", answer: "decline", channel: "app" }]);
  const declined = await s.get("/offers?state=declined");
  assert.equal(declined.json.offers.length, 1);
  await s.close();
});

test("expired or unknown mission offers: expired reads expired and answers 409, unknown 404, bad button 400", async () => {
  const s = await setup();
  s.rows.set("bbbbbbbb", mission("bbbbbbbb"));
  s.advance(TTL + 1);
  assert.equal((await s.get("/offers?state=expired")).json.offers.length, 1);
  assert.equal((await s.get("/offers")).json.offers.length, 0);
  const r = await s.post("/offers/bbbbbbbb/answer", { button: "approve" });
  assert.equal(r.status, 409);
  assert.equal((await s.post("/offers/cccccccc/answer", { button: "approve" })).status, 404);
  s.rows.set("dddddddd", mission("dddddddd", { created_at: s.rows.get("bbbbbbbb")!.created_at + TTL * 2, expires_at: T0 + TTL * 5 }));
  assert.equal((await s.post("/offers/dddddddd/answer", { button: "run" })).status, 400);
  await s.close();
});

test("mission states past approval read approved with the original channel", async () => {
  const s = await setup();
  s.rows.set("eeeeeeee", mission("eeeeeeee", { state: "running", answered_by: "telegram", answered_at: T0 + 1000 }));
  const o = (await s.get("/offers?state=approved")).json.offers[0];
  assert.equal(o.state, "approved");
  assert.equal(o.channel, "telegram");
  assert.equal(o.answeredButton, "approve");
  await s.close();
});
