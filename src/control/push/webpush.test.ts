import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveContentKeys, encryptWebPush, RECORD_SIZE } from "./webpush";

// RFC 8291 section 5 and Appendix A: the one worked example. Values copied from the RFC text (rfc8291.txt), whitespace removed.
const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prkKey: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  keyInfo: "V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  // Section 5: header and ciphertext as one base64url string.
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const b = (s: string) => Buffer.from(s, "base64url");

test("T6.1 RFC 8291 section 5: the encrypted body reproduces byte for byte", () => {
  const body = encryptWebPush(b(V.plaintext), { p256dh: V.uaPublic, auth: V.auth }, { salt: b(V.salt), senderPrivateKey: b(V.asPrivate) });
  assert.equal(body.toString("base64url"), V.body);
  // The RFC example prints "Content-Length: 145"; its own body decodes to 86 + 41 + 1 + 16 = 144 octets (a known erratum in the example).
  assert.equal(body.length, 144);
});

test("T6.1 RFC 8291 appendix A: every intermediate value, the 86-octet header and the ciphertext", () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(b(V.asPrivate));
  assert.equal(ecdh.getPublicKey().toString("base64url"), V.asPublic);
  assert.equal(ecdh.computeSecret(b(V.uaPublic)).toString("base64url"), V.ecdhSecret);
  const k = deriveContentKeys({ ecdhSecret: b(V.ecdhSecret), auth: b(V.auth), uaPublic: b(V.uaPublic), asPublic: b(V.asPublic), salt: b(V.salt) });
  assert.equal(k.keyInfo.toString("base64url"), V.keyInfo);
  assert.equal(k.ikm.toString("base64url"), V.ikm);
  assert.equal(k.cek.toString("base64url"), V.cek);
  assert.equal(k.nonce.toString("base64url"), V.nonce);
  const body = encryptWebPush(b(V.plaintext), { p256dh: V.uaPublic, auth: V.auth }, { salt: b(V.salt), senderPrivateKey: b(V.asPrivate) });
  assert.equal(body.subarray(0, 86).toString("base64url"), V.header);
  assert.equal(body.subarray(86).toString("base64url"), V.ciphertext);
  assert.equal(RECORD_SIZE, 4096);
});

/** The receiver's side, as the RFC describes it, to prove a round trip without sharing code with the sender. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = crypto.createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const keys = deriveContentKeys({ ecdhSecret: ua.computeSecret(asPublic), auth, uaPublic: ua.getPublicKey(), asPublic, salt });
  const rest = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv("aes-128-gcm", keys.cek, keys.nonce);
  d.setAuthTag(rest.subarray(rest.length - 16));
  const padded = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
  assert.equal(padded[padded.length - 1], 2, "the last record ends with the 0x02 delimiter");
  return padded.subarray(0, padded.length - 1);
}

test("T6.1 a fresh key and salt per message: header shape, round trip, and two encryptions differ", () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  const text = JSON.stringify({ v: 1, t: "test", id: "1", title: "Zażółć — ✓ ok" });
  const a = encryptWebPush(Buffer.from(text), keys);
  const c = encryptWebPush(Buffer.from(text), keys);
  assert.notDeepEqual(a, c);
  assert.equal(a.readUInt32BE(16), 4096);
  assert.equal(a[20], 65);
  assert.equal(a[21], 4, "uncompressed sender key");
  assert.equal(decrypt(a, ua.getPrivateKey(), auth).toString("utf8"), text);
  assert.equal(decrypt(c, ua.getPrivateKey(), auth).toString("utf8"), text);
  // standard base64 (with + and /) is also accepted: the P1 key pattern allows it
  const std = { p256dh: ua.getPublicKey().toString("base64"), auth: auth.toString("base64") };
  assert.equal(decrypt(encryptWebPush(Buffer.from("x"), std), ua.getPrivateKey(), auth).toString(), "x");
});

test("T6.1 bad subscription keys and oversized payloads throw without echoing key material", () => {
  const good = crypto.createECDH("prime256v1");
  good.generateKeys();
  const p256dh = good.getPublicKey().toString("base64url");
  const auth = crypto.randomBytes(16).toString("base64url");
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
  const bad: [string, { p256dh: string; auth: string }][] = [
    ["short p256dh", { p256dh: "BFakeKey_-1", auth }],
    ["compressed p256dh", { p256dh: good.getPublicKey(undefined, "compressed").toString("base64url"), auth }],
    ["off-curve p256dh", { p256dh: offCurve, auth }],
    ["short auth", { p256dh, auth: "FakeAuth_-1" }],
    ["long auth", { p256dh, auth: crypto.randomBytes(17).toString("base64url") }],
  ];
  for (const [what, keys] of bad) {
    assert.throws(() => encryptWebPush(Buffer.from("x"), keys), (e: Error) => { assert.ok(!e.message.includes(keys.p256dh) && !e.message.includes(keys.auth), what); return true; }, what);
  }
  assert.throws(() => encryptWebPush(Buffer.alloc(4096 - 16), { p256dh, auth }), /too large/);
  assert.doesNotThrow(() => encryptWebPush(Buffer.alloc(4096 - 17), { p256dh, auth }));
});
