import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEndpoint } from "./endpoint";

const BASE = "https://ntfy.203-0-113-10.sslip.io";
const OK = `${BASE}/upAb12Cd34Ef56Gh`;

test("an endpoint that is exactly base + /up + 8..64 [A-Za-z0-9_-] (+ optional ?up=1) yields its topic", () => {
  assert.equal(parseEndpoint(OK, BASE), "upAb12Cd34Ef56Gh");
  assert.equal(parseEndpoint(OK + "?up=1", BASE), "upAb12Cd34Ef56Gh");
  assert.equal(parseEndpoint(`${BASE}/up${"a".repeat(8)}`, BASE), "up" + "a".repeat(8));
  assert.equal(parseEndpoint(`${BASE}/up${"a_-".repeat(21)}a`, BASE), "up" + "a_-".repeat(21) + "a"); // 64 chars
  assert.equal(parseEndpoint(OK, BASE + "/"), "upAb12Cd34Ef56Gh", "a trailing slash on the configured base is ignored");
});

test("everything else is null: other host, http, userinfo, traversal, query injection, length, charset", () => {
  const bad = [
    `https://evil.example/upAb12Cd34Ef56Gh`,
    `https://ntfy.203-0-113-10.sslip.io.evil.example/upAb12Cd34Ef56Gh`,
    `https://evil.example@ntfy.203-0-113-10.sslip.io/upAb12Cd34Ef56Gh`,
    `https://ntfy.203-0-113-10.sslip.io@evil.example/upAb12Cd34Ef56Gh`,
    `https://user:pw@ntfy.203-0-113-10.sslip.io/upAb12Cd34Ef56Gh`,
    `http://ntfy.203-0-113-10.sslip.io/upAb12Cd34Ef56Gh`,
    `HTTPS://ntfy.203-0-113-10.sslip.io/upAb12Cd34Ef56Gh`,
    `https://ntfyX203-0-113-10.sslip.io/upAb12Cd34Ef56Gh`,
    `${BASE}/upAb12Cd34Ef56Gh/..`,
    `${BASE}/../upAb12Cd34Ef56Gh`,
    `${BASE}/up../../x1234567`,
    `${BASE}/upAb12Cd34Ef56Gh/`,
    `${BASE}/upAb12Cd34Ef56Gh?up=1&x=2`,
    `${BASE}/upAb12Cd34Ef56Gh?up=2`,
    `${BASE}/upAb12Cd34Ef56Gh?`,
    `${BASE}/upAb12Cd34Ef56Gh#frag`,
    `${BASE}/upAb12Cd34Ef56Gh\n`,
    `${BASE}/upAb12Cd34Ef56Gh `,
    ` ${BASE}/upAb12Cd34Ef56Gh`,
    `${BASE}/up${"a".repeat(65)}`,
    `${BASE}/up${"a".repeat(7)}`,
    `${BASE}/up`,
    `${BASE}/Up${"a".repeat(8)}`,
    `${BASE}/xp${"a".repeat(8)}`,
    `${BASE}/upAb12Cd34Ef56G%68`,
    `${BASE}/upAb12Cd34Ef56G.h`,
    `${BASE}/upAb12Cd34Ef56Gh%0d%0a`,
    BASE,
    `${BASE}/`,
    "",
  ];
  for (const e of bad) assert.equal(parseEndpoint(e, BASE), null, JSON.stringify(e));
  for (const e of [undefined, null, 5, {}, [OK], true]) assert.equal(parseEndpoint(e, BASE), null);
});

test("an empty or malformed configured base accepts nothing", () => {
  for (const base of ["", "http://x.example", "not a url", "https://"]) assert.equal(parseEndpoint(OK, base), null, base);
});
