import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, type CliDeps } from "./cli";

const triage = [
  { name: "a", host: "server", completeness: 1, next_action: "fix-defects", open_tasks: 2 },
  { name: "b", host: "server", completeness: 2, next_action: "write-specs", open_tasks: 1 },
];
const recs = [{ name: "a", recommendations: [{ code: "R1", title: "T1", kind: "feature", why: "w", evidence: [], size: "S", impact: 2 }] }];

function setup(files: Record<string, string>, failFor: string[] = [], triageFails = false) {
  const posts: { path: string; body: any }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  let n = 0;
  const deps: CliDeps = {
    readFile: (p) => (p in written ? written[p] : p in files ? files[p] : null),
    writeFile: (p, s) => { written[p] = s; },
    post: async (path, body: any) => {
      posts.push({ path, body });
      if (path === "/api/internal/triage") return triageFails ? { ok: false, status: 500, json: { error: "x" } } : { ok: true, status: 200, json: { ok: true } };
      if (failFor.includes(body.project)) return { ok: false, status: 503, json: { error: "down" } };
      return { ok: true, status: 200, json: { id: `id${++n}`, project: body.project } };
    },
    now: () => 1_000_000_000_000,
    ctx: { getProject: (name) => ({ name, location: "server", path: `/x/${name}` }), recentSkips: () => 0, readerFor: () => null },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, posts, out, err, written };
}
const F = { "/t/2026-10-09.json": JSON.stringify(triage), "/t/2026-10-09.recs.json": JSON.stringify(recs) };
const ARGS = ["/t/2026-10-09.json", "--recs", "/t/2026-10-09.recs.json", "--date", "2026-10-09"];
const offerPosts = (p: { path: string; body: any }[]) => p.filter((x) => x.path === "/api/internal/action-offer");

test("real mode posts the triage once, then one card per project, lowest completeness first", async () => {
  const s = setup(F);
  assert.equal(await runCli(ARGS, s.deps), 0);
  assert.equal(s.posts[0].path, "/api/internal/triage");
  assert.equal(s.posts[0].body.date, "2026-10-09");
  assert.equal(s.posts[0].body.projects.length, 2);
  const o = offerPosts(s.posts);
  assert.deepEqual(o.map((p) => p.body.project), ["a", "b"]);
  assert.equal(o[0].body.from, "finish-apps-2026-10-09");
  assert.ok(o[0].body.buttons.some((b: any) => b.id === "spec1"));
  assert.ok(!o[1].body.buttons.some((b: any) => b.id === "spec1"));
});

test("--dry-run prints one line per card and posts nothing", async () => {
  const s = setup(F);
  assert.equal(await runCli([...ARGS, "--dry-run"], s.deps), 0);
  assert.equal(s.posts.length, 0);
  assert.equal(s.out.length, 2);
  assert.match(s.out[0], /^a \| /);
  assert.match(s.out[0], /spec1/);
  assert.equal(Object.keys(s.written).length, 0);
});

test("missing or malformed recs file: cards still go out", async () => {
  for (const files of [{ "/t/2026-10-09.json": F["/t/2026-10-09.json"] }, { ...F, "/t/2026-10-09.recs.json": "{not json" }]) {
    const s = setup(files);
    assert.equal(await runCli(ARGS, s.deps), 0);
    const o = offerPosts(s.posts);
    assert.equal(o.length, 2);
    assert.ok(o.every((p) => !p.body.buttons.some((b: any) => b.id === "spec1")));
  }
});

test("re-run the same day creates no duplicates", async () => {
  const s = setup(F);
  await runCli(ARGS, s.deps);
  const first = offerPosts(s.posts).length;
  await runCli(ARGS, s.deps);
  assert.equal(offerPosts(s.posts).length, first);
});

test("one POST failure does not stop the others; failed one is retried next run", async () => {
  const s = setup(F, ["a"]);
  assert.equal(await runCli(ARGS, s.deps), 1);
  assert.deepEqual(offerPosts(s.posts).map((p) => p.body.project), ["a", "b"]);
  assert.ok(s.err.some((l) => /a/.test(l) && /503|down/.test(l)));
  const s2 = { ...s };
  s2.deps.post = async (path, body: any) => { s.posts.push({ path, body }); return { ok: true, status: 200, json: { id: "z", project: body.project } }; };
  await runCli(ARGS, s2.deps);
  assert.deepEqual(offerPosts(s.posts).map((p) => p.body.project), ["a", "b", "a"]);
});

test("a failing triage POST does not stop the cards", async () => {
  const s = setup(F, [], true);
  assert.equal(await runCli(ARGS, s.deps), 0);
  assert.equal(offerPosts(s.posts).length, 2);
});

test("malformed triage file is a usage error", async () => {
  const s = setup({ "/t/2026-10-09.json": "nope" });
  assert.equal(await runCli(ARGS, s.deps), 2);
  assert.equal(s.posts.length, 0);
  assert.equal(await runCli([], setup({}).deps), 2);
});
