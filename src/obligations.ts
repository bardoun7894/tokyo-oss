// Money owed: recurring bills (rent on the 26th) and loans with a balance.
//
// Everything here is pure so the date maths can be tested: a bill due on the
// 31st still has to land in February, "paid" has to mean paid for THIS month,
// and an overdue bill must stay overdue rather than quietly rolling to next
// month.

export type ObligationKind = "bill" | "loan";

export interface Obligation {
  id: number;
  name: string;
  kind: ObligationKind;
  counterparty: string | null;
  amount: number;
  currency: string;
  due_day: number | null;
  principal: number | null;
  notes: string | null;
  active: number;
}

export interface Payment {
  id: number;
  obligation_id: number;
  amount: number;
  paid_at: string;      // YYYY-MM-DD
  period: string | null; // YYYY-MM the payment covers, bills only
  proof_path: string | null;
  note: string | null;
}

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The due date inside `today`'s month, clamped to the last day when the month
 * is shorter: a rent due on the 31st is due on the 28th in February, not on
 * the 3rd of March.
 */
export function dueDateInMonth(dueDay: number, today: string): string {
  const [y, m] = today.split("-").map(Number);
  return iso(y, m - 1, Math.min(dueDay, daysInMonth(y, m - 1)));
}

export function addMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export interface BillStatus {
  period: string;        // the month this status is about
  dueDate: string;
  paid: boolean;
  paidAmount: number;
  daysUntilDue: number;  // negative when the due date has passed
  overdue: boolean;
}

/**
 * Status of a bill for the current month. Once this month is paid, it reports
 * next month so "next due" always points at something owed.
 */
export function billStatus(o: Obligation, payments: Payment[], today: string): BillStatus {
  const dueDay = o.due_day ?? 1;
  const thisPeriod = periodOf(today);
  const paidFor = (period: string) =>
    payments.filter((p) => (p.period ?? periodOf(p.paid_at)) === period).reduce((n, p) => n + p.amount, 0);

  const paidThis = paidFor(thisPeriod);
  if (paidThis > 0) {
    const next = addMonth(thisPeriod);
    const dueDate = dueDateInMonth(dueDay, `${next}-01`);
    return {
      period: next, dueDate, paid: paidFor(next) > 0, paidAmount: paidFor(next),
      daysUntilDue: daysBetween(today, dueDate), overdue: false,
    };
  }

  const dueDate = dueDateInMonth(dueDay, today);
  const daysUntilDue = daysBetween(today, dueDate);
  return { period: thisPeriod, dueDate, paid: false, paidAmount: 0, daysUntilDue, overdue: daysUntilDue < 0 };
}

export interface LoanStatus {
  principal: number;
  paid: number;
  remaining: number;
  progress: number; // 0-100
  lastPaidAt: string | null;
}

export function loanStatus(o: Obligation, payments: Payment[]): LoanStatus {
  const principal = o.principal ?? 0;
  const paid = payments.reduce((n, p) => n + p.amount, 0);
  const remaining = Math.max(0, principal - paid);
  const progress = principal > 0 ? Math.min(100, (paid / principal) * 100) : 0;
  const lastPaidAt = payments.length
    ? payments.map((p) => p.paid_at).sort().slice(-1)[0]
    : null;
  return { principal, paid, remaining, progress, lastPaidAt };
}

/**
 * Bills worth a reminder today: due within `daysAhead`, or already overdue,
 * and not yet paid for their period.
 */
export function needsReminder(o: Obligation, payments: Payment[], today: string, daysAhead = 2): BillStatus | null {
  if (!o.active || o.kind !== "bill") return null;
  const s = billStatus(o, payments, today);
  if (s.paid) return null;
  return s.daysUntilDue <= daysAhead ? s : null;
}
