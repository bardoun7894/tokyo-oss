/**
 * Obligations: what is owed and what has been paid.
 *
 * Mounted under /api/obligations. Amounts are money, so every write validates
 * its numbers and refuses anything it cannot read as a positive amount — a
 * silently-zero row is exactly the bug the income table already has.
 */
import express, { type Request, type Response } from "express";
import * as db from "../db";
import { billStatus, loanStatus, periodOf, type Obligation } from "../obligations";
import { localToday } from "../utils";

const router = express.Router();

function money(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function withStatus(o: Obligation, today: string) {
  const payments = db.listObligationPayments(o.id);
  return {
    ...o,
    payments,
    status: o.kind === "bill" ? billStatus(o, payments, today) : null,
    loan: o.kind === "loan" ? loanStatus(o, payments) : null,
  };
}

// GET /api/obligations — bills with their next due date, loans with their balance
router.get("/api/obligations", (req: Request, res: Response) => {
  try {
    const today = localToday();
    const items = db.listObligations(req.query.all === "1").map((o) => withStatus(o, today));
    res.json({ today, items });
  } catch (err) {
    console.error("obligations list error:", err);
    res.status(500).json({ error: "Failed to load obligations" });
  }
});

// POST /api/obligations
router.post("/api/obligations", (req: Request, res: Response) => {
  const { name, kind, counterparty, amount, currency, dueDay, principal, notes } = req.body || {};
  if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name required" }); return; }
  if (kind !== "bill" && kind !== "loan") { res.status(400).json({ error: "kind must be bill or loan" }); return; }

  const amt = amount === undefined || amount === "" ? 0 : money(amount);
  if (amt === null) { res.status(400).json({ error: "amount must be a positive number" }); return; }

  let day: number | null = null;
  if (kind === "bill") {
    day = Number(dueDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) { res.status(400).json({ error: "dueDay must be 1-31" }); return; }
  }

  let total: number | null = null;
  if (kind === "loan" && principal !== undefined && principal !== "") {
    total = money(principal);
    if (total === null) { res.status(400).json({ error: "principal must be a positive number" }); return; }
  }

  try {
    const r = db.addObligation({
      name: name.trim(), kind, counterparty: counterparty?.trim() || null, amount: amt,
      currency: (currency || "DH").trim(), dueDay: day, principal: total, notes: notes?.trim() || null,
    });
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (err) {
    console.error("obligation create error:", err);
    res.status(500).json({ error: "Failed to save" });
  }
});

// POST /api/obligations/:id/pay
router.post("/api/obligations/:id/pay", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const o = db.getObligation(id);
  if (!o) { res.status(404).json({ error: "Not found" }); return; }

  const amount = money(req.body?.amount ?? o.amount);
  if (amount === null) { res.status(400).json({ error: "amount must be a positive number" }); return; }

  const paidAt = typeof req.body?.paidAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.paidAt)
    ? req.body.paidAt : localToday();
  // A bill payment covers a month: the one given, else the month it was paid in.
  const period = o.kind === "bill"
    ? (typeof req.body?.period === "string" && /^\d{4}-\d{2}$/.test(req.body.period) ? req.body.period : periodOf(paidAt))
    : null;

  const proof = typeof req.body?.proofPath === "string" ? req.body.proofPath.trim() : "";
  if (proof && (proof.includes("..") || !proof.startsWith("whatsapp-media/"))) {
    res.status(400).json({ error: "proofPath must be a whatsapp-media file" });
    return;
  }

  try {
    db.addObligationPayment({
      obligationId: id, amount, paidAt, period,
      proofPath: proof || null, note: req.body?.note?.trim() || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("obligation pay error:", err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// DELETE /api/obligations/payments/:id — undo a payment recorded by mistake
router.delete("/api/obligations/payments/:id", (req: Request, res: Response) => {
  try {
    db.deleteObligationPayment(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error("obligation payment delete error:", err);
    res.status(500).json({ error: "Failed to delete payment" });
  }
});

// PATCH /api/obligations/:id — amounts move; an unknown amount stays unset
// rather than being guessed.
router.patch("/api/obligations/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const o = db.getObligation(id);
  if (!o) { res.status(404).json({ error: "Not found" }); return; }

  const fields: Parameters<typeof db.updateObligation>[1] = {};
  const b = req.body || {};

  if (typeof b.name === "string") {
    if (!b.name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
    fields.name = b.name.trim();
  }
  if (b.counterparty !== undefined) fields.counterparty = String(b.counterparty).trim() || null;
  if (b.notes !== undefined) fields.notes = String(b.notes).trim() || null;

  // "" clears an amount back to unknown; any other value must be a real number.
  if (b.amount !== undefined) {
    if (b.amount === "" || b.amount === null) fields.amount = 0;
    else {
      const n = money(b.amount);
      if (n === null) { res.status(400).json({ error: "amount must be a positive number" }); return; }
      fields.amount = n;
    }
  }
  if (b.principal !== undefined) {
    if (b.principal === "" || b.principal === null) fields.principal = null;
    else {
      const n = money(b.principal);
      if (n === null) { res.status(400).json({ error: "principal must be a positive number" }); return; }
      fields.principal = n;
    }
  }

  if (b.dueDay !== undefined && o.kind === "bill") {
    const day = Number(b.dueDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) { res.status(400).json({ error: "dueDay must be 1-31" }); return; }
    fields.dueDay = day;
  }

  try {
    db.updateObligation(id, fields);
    res.json({ ok: true });
  } catch (err) {
    console.error("obligation update error:", err);
    res.status(500).json({ error: "Failed to update" });
  }
});

// POST /api/obligations/:id/archive { active: boolean }
router.post("/api/obligations/:id/archive", (req: Request, res: Response) => {
  try {
    db.setObligationActive(Number(req.params.id), req.body?.active === true);
    res.json({ ok: true });
  } catch (err) {
    console.error("obligation archive error:", err);
    res.status(500).json({ error: "Failed to update" });
  }
});

// DELETE /api/obligations/:id — removes its payments too
router.delete("/api/obligations/:id", (req: Request, res: Response) => {
  try {
    db.deleteObligation(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error("obligation delete error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

export default router;
