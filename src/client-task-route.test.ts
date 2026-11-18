import { test } from "node:test";
import assert from "node:assert/strict";
import { decideClientRoute } from "./client-task-route";

const a = (choice: string, confidence: number) => ({ type: "choice" as const, choice, confidence });
const laptop = { location: "laptop" as const, hasMission: false };
const serverMission = { location: "server" as const, hasMission: true };
const serverBare = { location: "server" as const, hasMission: false };

test("no Jev answer falls back to asking", () => {
  assert.equal(decideClientRoute(null, laptop).action, "ask");
});

test("unsure kind asks, confident personal skips", () => {
  assert.equal(decideClientRoute({ kind: a("coding", 0.7), target: a("website", 0.99) }, serverMission).action, "ask");
  assert.equal(decideClientRoute({ kind: a("personal", 0.95), target: a("none", 0.9) }, serverMission).action, "skip");
  assert.equal(decideClientRoute({ kind: a("unclear", 0.95), target: a("none", 0.9) }, serverMission).action, "ask");
});

test("website work runs on the server when the project has a mission config", () => {
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("website", 0.9) }, serverMission).action, "mission");
});

test("website work on a laptop-only repo runs on the laptop", () => {
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("website", 0.9) }, laptop).action, "run");
});

test("mobile app work runs on the laptop, never the server", () => {
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("mobile_app", 0.9) }, laptop).action, "run");
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("mobile_app", 0.9) }, serverMission).action, "ask");
});

test("unclear target asks; website work on a server project without a mission config runs there", () => {
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("website", 0.6) }, serverMission).action, "ask");
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("none", 0.95) }, laptop).action, "ask");
  assert.equal(decideClientRoute({ kind: a("coding", 0.95), target: a("website", 0.95) }, serverBare).action, "run");
});
