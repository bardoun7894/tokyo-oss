import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedAddress } from "./net-guard";

test("loopback is trusted, in both address families", () => {
  assert.equal(isTrustedAddress("127.0.0.1"), true);
  assert.equal(isTrustedAddress("127.1.2.3"), true);
  assert.equal(isTrustedAddress("::1"), true);
  assert.equal(isTrustedAddress("::ffff:127.0.0.1"), true);
});

test("the tailnet is trusted, including dual-stack mapped peers", () => {
  assert.equal(isTrustedAddress("100.64.0.1"), true);
  assert.equal(isTrustedAddress("100.64.0.50"), true);
  assert.equal(isTrustedAddress("::ffff:100.64.0.1"), true);
  // 100.64.0.0/10 ends at 100.127.255.255 — the next address is public CGNAT space
  assert.equal(isTrustedAddress("100.127.255.255"), true);
  assert.equal(isTrustedAddress("100.128.0.1"), false);
  assert.equal(isTrustedAddress("100.63.255.255"), false);
});

test("this host's own public address is refused", () => {
  // The exact address that answered POST /api/auth/login from the open internet.
  assert.equal(isTrustedAddress("203.0.113.10"), false);
});

test("the public internet and the LAN are refused", () => {
  assert.equal(isTrustedAddress("8.8.8.8"), false);
  assert.equal(isTrustedAddress("192.168.1.10"), false);
  assert.equal(isTrustedAddress("10.0.0.5"), false);
  assert.equal(isTrustedAddress("172.17.0.2"), false); // docker bridge
});

test("an address we cannot parse is denied, never guessed", () => {
  assert.equal(isTrustedAddress(undefined), false);
  assert.equal(isTrustedAddress(""), false);
  assert.equal(isTrustedAddress("not-an-address"), false);
  assert.equal(isTrustedAddress("100.64.0"), false);
  assert.equal(isTrustedAddress("100.64.0.999"), false);
  assert.equal(isTrustedAddress("100.64.0.1.5"), false);
  // A real public IPv6 peer cannot be matched against IPv4 CIDRs.
  assert.equal(isTrustedAddress("2a02:c207:2301:5200::1"), false);
});

test("a spoofed prefix does not sneak past the mask", () => {
  assert.equal(isTrustedAddress("100.64.0.1.evil.com"), false);
  assert.equal(isTrustedAddress(" 100.64.0.1"), false);
  assert.equal(isTrustedAddress("0100.64.0.1"), false);
});
