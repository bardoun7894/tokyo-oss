import { test } from "node:test";
import assert from "node:assert/strict";
import { laptopHost, serverHost, runInHerdr, laptopLauncher, type Exec } from "./herdr-run";

const ID = "0a1b2c3d";
const FILE = '{"a":1}\n{"b":2}\n{"c":3}\n{"d":';

// A fake host that serves FILE for `tail -c +N path | head -c M` and records every call.
function fake(content = FILE) {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    const cmd = argv.at(-1)!;
    const m = /tail -c \+(\d+) \S+ \| head -c (\d+)$/.exec(cmd);
    if (m) return { code: 0, stdout: Buffer.from(content).subarray(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2])).toString(), stderr: "" };
    const w = /wc -c < \S+$/.exec(cmd);
    if (w) return { code: 0, stdout: `${Buffer.byteLength(content)}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

for (const [name, mk] of [["server", serverHost], ["laptop", laptopHost]] as const) {
  test(`${name}: readFrom returns only complete lines after the offset and the new offset`, async () => {
    const h = mk(fake().exec);
    assert.deepEqual(await h.readFrom(ID, 0, 1000), { text: '{"a":1}\n{"b":2}\n{"c":3}\n', offset: 24 });
    assert.deepEqual(await h.readFrom(ID, 8, 1000), { text: '{"b":2}\n{"c":3}\n', offset: 24 });
    assert.deepEqual(await h.readFrom(ID, 24, 1000), { text: "", offset: 24 });
  });

  test(`${name}: readFrom caps at maxBytes on a line boundary`, async () => {
    const h = mk(fake().exec);
    assert.deepEqual(await h.readFrom(ID, 0, 17), { text: '{"a":1}\n{"b":2}\n', offset: 16 });
  });

  test(`${name}: a single line longer than maxBytes is consumed whole so the cursor cannot stall`, async () => {
    const h = mk(fake("x".repeat(50) + "\n").exec);
    const r = await h.readFrom(ID, 0, 10);
    assert.equal(r.text, "x".repeat(10));
    assert.equal(r.offset, 10);
  });

  test(`${name}: readFrom validates id and offsets, size reads the byte length`, async () => {
    const h = mk(fake().exec);
    await assert.rejects(() => h.readFrom("../x", 0, 10), /invalid run id/);
    await assert.rejects(() => h.readFrom(ID, -1, 10), /invalid offset/);
    await assert.rejects(() => h.readFrom(ID, 0, 0), /invalid/);
    await assert.rejects(() => h.readFrom(ID, 1.5, 10), /invalid offset/);
    assert.equal(await h.size(ID), 29);
  });
}

test("server: stop runs `hsess kill <label>` without a shell", async () => {
  const f = fake();
  await serverHost(f.exec).stop("tokyo-run-0a1b2c3d");
  assert.deepEqual(f.calls.at(-1), ["hsess", "kill", "tokyo-run-0a1b2c3d"]);
});

test("laptop: stop runs `hsess kill <label>` over ssh", async () => {
  const f = fake();
  await laptopHost(f.exec).stop("tokyo-run-0a1b2c3d");
  assert.equal(f.calls.at(-1)![0], "ssh");
  assert.match(f.calls.at(-1)!.at(-1)!, /hsess kill tokyo-run-0a1b2c3d$/);
});

test("stop rejects labels with shell metacharacters and surfaces a failing kill", async () => {
  for (const mk of [serverHost, laptopHost]) {
    const f = fake();
    for (const bad of ["a;rm -rf ~", "a b", "$(id)", "a`id`", "", "../x", "a|b", "x".repeat(81)]) {
      await assert.rejects(() => mk(f.exec).stop(bad), /invalid workspace label/, bad);
    }
    assert.equal(f.calls.length, 0);
  }
  const failing: Exec = async () => ({ code: 1, stdout: "", stderr: "no such workspace" });
  await assert.rejects(() => serverHost(failing).stop("tokyo-run-0a1b2c3d"), /hsess kill/);
});

test("runInHerdr reports label and run id early, and stops polling once cancelled", async () => {
  const f = fake();
  const started: [string, string][] = [];
  let cancelled = false;
  const exec: Exec = async (argv, o) => { if (argv.join(" ").includes("exit_code")) return { code: 1, stdout: "", stderr: "" }; return f.exec(argv, o); };
  const r = await runInHerdr(laptopHost(exec), "/Users/owner/projects/up", "x", (id) => laptopLauncher(id, "/Users/owner/projects/up", { model: "m", proxyUrl: "u", authToken: "t" }), {
    id: ID, capMs: 60_000, sleep: async () => { cancelled = true; },
    onStarted: async (label, id) => { started.push([label, id]); },
    isCancelled: () => cancelled,
  });
  assert.deepEqual(started, [["tokyo-run-0a1b2c3d", ID]]);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.match(r.output, /stopped/i);
});
