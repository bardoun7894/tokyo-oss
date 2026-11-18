import { test } from "node:test";
import assert from "node:assert/strict";
import { shopDailyRealDh } from "./shop-insights";

test("shopDailyRealDh: one row per day in range, newest first, real DH and a sale count", () => {
  const sales = [
    { amount: 6, date: "2026-09-13" },
    { amount: 3.5, date: "2026-09-14" },
    { amount: 2, date: "2026-09-14" },
    { amount: 9, date: "2026-09-19" },
    { amount: 1, date: "2026-09-12" },
  ];
  assert.deepEqual(shopDailyRealDh(sales, "2026-09-13", "2026-09-19", 10), [
    { date: "2026-09-19", total_revenue: 90, items_sold: 1 },
    { date: "2026-09-14", total_revenue: 55, items_sold: 2 },
    { date: "2026-09-13", total_revenue: 60, items_sold: 1 },
  ]);
});
