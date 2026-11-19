import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_STEPS, parseAnswer, mergeEnv, countryDefaults } from "./setup-steps";

const step = (key: string) => SETUP_STEPS.find((s) => s.key === key)!;

test("an Egyptian user gets Cairo time, EGP and Egyptian Arabic suggested", () => {
  assert.equal(step("TIMEZONE").suggest!({ PROFILE_COUNTRY: "Egypt" }), "Africa/Cairo");
  assert.equal(step("CURRENCY").suggest!({ PROFILE_COUNTRY: "مصر" }), "EGP");
  assert.equal(step("PROFILE_LANGUAGE").suggest!({ PROFILE_COUNTRY: "egypt" }), "Egyptian Arabic");
  assert.equal(countryDefaults("Egypt")!.prayerMethod, "5");
});

test("an unknown country suggests nothing", () => {
  assert.equal(step("TIMEZONE").suggest!({ PROFILE_COUNTRY: "Atlantis" }), undefined);
  assert.equal(countryDefaults(undefined), undefined);
});

test("yes/no answers in English and Arabic become 1/0", () => {
  assert.deepEqual(parseAnswer(step("FEATURE_SHOP"), "no"), { value: "0" });
  assert.deepEqual(parseAnswer(step("FEATURE_SHOP"), "لا"), { value: "0" });
  assert.deepEqual(parseAnswer(step("FEATURE_PRAYER"), "ايوه"), { value: "1" });
  assert.ok(parseAnswer(step("FEATURE_PRAYER"), "maybe").error);
});

test("skip keeps the current value; bad timezones are refused", () => {
  assert.deepEqual(parseAnswer(step("PROFILE_WORK"), "skip"), { skip: true });
  assert.deepEqual(parseAnswer(step("PROFILE_WORK"), "  "), { skip: true });
  assert.ok(parseAnswer(step("TIMEZONE"), "Mars/Base").error);
  assert.deepEqual(parseAnswer(step("TIMEZONE"), "Africa/Cairo"), { value: "Africa/Cairo" });
  assert.deepEqual(parseAnswer(step("CURRENCY"), "egp"), { value: "EGP" });
});

test("no step asks for an API key or token", () => {
  for (const s of SETUP_STEPS) assert.doesNotMatch(s.key, /KEY|TOKEN|SECRET|PASS/);
});

test("mergeEnv replaces values in place, keeps comments, appends new keys, quotes spaces", () => {
  const before = "# You\nTIMEZONE=UTC\nCURRENCY=USD   # code\nOTHER=x\n";
  const after = mergeEnv(before, { TIMEZONE: "Africa/Cairo", PROFILE_WORK: "Nurse, night shifts" });
  assert.equal(after, '# You\nTIMEZONE=Africa/Cairo\nCURRENCY=USD   # code\nOTHER=x\n\nPROFILE_WORK="Nurse, night shifts"\n');
});
