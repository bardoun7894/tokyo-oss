import { test } from "node:test";
import assert from "node:assert/strict";
import { listTargets, macReach, resolveTarget, VARIANTS, type TargetsDeps } from "./targets";

const projects = [
  { name: "alpha", location: "server" as const },
  { name: "bravo", location: "laptop" as const },
  { name: "cust", location: "server" as const },
];

function deps(over: Partial<TargetsDeps> = {}): TargetsDeps {
  return { projects: () => projects, isReportOnly: (n) => n === "cust", macOnline: async () => true, ...over };
}

test("variants are kb-dev and tech-company", () => {
  assert.deepEqual([...VARIANTS], ["kb-dev", "tech-company"]);
});

test("G1: server and Mac projects, report-only excluded; macOnline only on Mac projects", async () => {
  const got = await listTargets(deps());
  assert.deepEqual(got, [
    { name: "alpha", host: "server", variants: ["kb-dev", "tech-company"] },
    { name: "bravo", host: "mac", macOnline: true, variants: ["kb-dev", "tech-company"] },
  ]);
});

test("G1: Mac asleep reads macOnline:false; a probe that throws is false; with no Mac project the probe is not asked", async () => {
  assert.equal((await listTargets(deps({ macOnline: async () => false })))[1]!.macOnline, false);
  assert.equal((await listTargets(deps({ macOnline: async () => { throw new Error("ssh: Bearer tk_secret"); } })))[1]!.macOnline, false);
  let asked = 0;
  await listTargets(deps({ projects: () => [projects[0]!], macOnline: async () => { asked++; return true; } }));
  assert.equal(asked, 0);
});

test("resolveTarget: a listed project, else null for unknown and report-only", () => {
  assert.deepEqual(resolveTarget(deps(), "alpha"), projects[0]);
  assert.equal(resolveTarget(deps(), "cust"), null);
  assert.equal(resolveTarget(deps(), "nope"), null);
});

test("macReach: one fixed ssh argv, 0 is online, anything else is not, cached for 30 s", async () => {
  const calls: string[][] = [];
  let code: number | null = 0;
  let t = 1_000;
  const exec = async (file: string, args: readonly string[]) => { calls.push([file, ...args]); return { code, stdout: "ok\n", stderr: "", timedOut: false }; };
  const reach = macReach(exec, () => t);
  assert.equal(await reach(), true);
  assert.equal(await reach(), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "mac", "echo", "ok"]);
  t += 31_000;
  code = 255;
  assert.equal(await reach(), false);
  assert.equal(calls.length, 2);
});
