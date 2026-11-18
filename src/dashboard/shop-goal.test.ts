import { test } from "node:test";
import assert from "node:assert/strict";
import { shopRealDhInRange } from "./shop-insights";

test("shopRealDhInRange: only sales inside the range, scaled to real dirhams", () => {
  const sales = [
    { amount: 6, date: "2026-08-31" },
    { amount: 12.5, date: "2026-09-01" },
    { amount: 30, date: "2026-09-19" },
    { amount: 9, date: "2026-09-30" },
    { amount: 4, date: "2026-10-01" },
  ];
  assert.equal(shopRealDhInRange(sales, "2026-09-01", "2026-09-30", 10), 515);
  assert.equal(shopRealDhInRange([], "2026-09-01", "2026-09-30", 10), 0);
});
