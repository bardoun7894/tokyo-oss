import { test } from "node:test";
import assert from "node:assert/strict";
import { getProject, matchProject } from "./project-registry";

test("acme-site is registered by name", () => {
  assert.equal(getProject("acme-site")?.path, "/srv/acme-site");
});

test("acme-site resolves via its alias", () => {
  assert.equal(matchProject("acme")?.path, "/srv/acme-site");
});

test("acme-site deploys on its remote host", () => {
  const r = getProject("acme-site")?.deployRemote;
  assert.equal(r?.host, "client-server");
  assert.equal(r?.path, "/srv/acme-site");
  assert.equal(r?.testPath, "/srv/acme-site-ci");
  assert.equal(r?.branch, "main");
});

test("server projects expose their live URL", () => {
  assert.equal(getProject("acme-site")?.url, "https://acme.example/app");
  assert.equal(getProject("crmdemo")?.url, "https://example.com/crm");
  assert.equal(getProject("appstudio")?.url, "http://127.0.0.1:8600");
  assert.equal(getProject("godhome")?.url, "http://127.0.0.1:8000");
});

test("edudemo-erp resolves by name and by every alias, with its documented deploy", () => {
  const p = getProject("edudemo-erp");
  assert.equal(p?.path, "/srv/edudemo-erp");
  assert.equal(p?.location, "server");
  assert.equal(p?.deployRemote, undefined, "prod is on this host");
  for (const a of ["edudemo", "edudemo erp", "EduDemo-ERP"]) {
    assert.equal(matchProject(a)?.name, "edudemo-erp", a);
  }
  assert.match(p?.deployNote ?? "", /gate-submit edudemo-predeploy 150m/);
  assert.match(p?.deployNote ?? "", /git merge -q --ff-only <sha>/);
});
