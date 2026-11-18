import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueDateInMonth, addMonth, daysBetween, billStatus, loanStatus, needsReminder, periodOf,
  type Obligation, type Payment } from './obligations';

const rent = (over: Partial<Obligation> = {}): Obligation => ({
  id: 1, name: 'كراء', kind: 'bill', counterparty: 'Hind', amount: 1500, currency: 'DH',
  due_day: 26, principal: null, notes: null, active: 1, ...over,
});
const pay = (over: Partial<Payment> = {}): Payment => ({
  id: 1, obligation_id: 1, amount: 1500, paid_at: '2026-09-26', period: '2026-09',
  proof_path: null, note: null, ...over,
});

test('a due day past the end of a short month lands on its last day', () => {
  assert.equal(dueDateInMonth(26, '2026-09-20'), '2026-09-26');
  assert.equal(dueDateInMonth(31, '2026-02-10'), '2026-02-28', 'February, not March 3rd');
  assert.equal(dueDateInMonth(31, '2024-02-10'), '2024-02-29', 'leap year');
  assert.equal(dueDateInMonth(31, '2026-04-01'), '2026-04-30');
});

test('month and day arithmetic', () => {
  assert.equal(addMonth('2026-12'), '2027-01');
  assert.equal(addMonth('2026-09'), '2026-10');
  assert.equal(daysBetween('2026-09-20', '2026-09-26'), 6);
  assert.equal(daysBetween('2026-09-27', '2026-09-26'), -1);
  assert.equal(periodOf('2026-09-26'), '2026-09');
});

test('unpaid rent counts down to its due date this month', () => {
  const s = billStatus(rent(), [], '2026-09-20');
  assert.deepEqual([s.period, s.dueDate, s.paid, s.daysUntilDue, s.overdue], ['2026-09', '2026-09-26', false, 6, false]);
});

test('an unpaid bill past its day is overdue, it does not roll to next month', () => {
  const s = billStatus(rent(), [], '2026-09-28');
  assert.equal(s.period, '2026-09');
  assert.equal(s.overdue, true);
  assert.equal(s.daysUntilDue, -2);
});

test('once this month is paid, next due points at next month', () => {
  const s = billStatus(rent(), [pay()], '2026-09-27');
  assert.equal(s.period, '2026-10');
  assert.equal(s.dueDate, '2026-10-26');
  assert.equal(s.paid, false);
  assert.equal(s.overdue, false);
});

test('a payment dated in a month counts for that month when no period is set', () => {
  const s = billStatus(rent(), [pay({ period: null, paid_at: '2026-09-02' })], '2026-09-20');
  assert.equal(s.period, '2026-10', 'September is settled');
});

test('paying early for next month shows next month as paid', () => {
  const s = billStatus(rent(), [pay(), pay({ id: 2, period: '2026-10' })], '2026-09-27');
  assert.equal(s.period, '2026-10');
  assert.equal(s.paid, true);
  assert.equal(s.paidAmount, 1500);
});

test('loan balance, progress and last payment', () => {
  const loan = rent({ kind: 'loan', name: 'Shop loan', principal: 30000, amount: 10000, due_day: null });
  const s = loanStatus(loan, [pay({ amount: 10000, paid_at: '2026-08-05', period: null }), pay({ id: 2, amount: 9999, paid_at: '2026-09-18', period: null })]);
  assert.equal(s.paid, 19999);
  assert.equal(s.remaining, 10001);
  assert.equal(Math.round(s.progress), 67);
  assert.equal(s.lastPaidAt, '2026-09-18');
});

test('a loan paid past its principal never goes negative', () => {
  const loan = rent({ kind: 'loan', principal: 1000, due_day: null });
  const s = loanStatus(loan, [pay({ amount: 1500, period: null })]);
  assert.equal(s.remaining, 0);
  assert.equal(s.progress, 100);
});

test('reminders fire two days ahead, on the day, and while overdue', () => {
  assert.equal(needsReminder(rent(), [], '2026-09-23'), null, 'three days out is too early');
  assert.ok(needsReminder(rent(), [], '2026-09-24'), 'two days ahead');
  assert.ok(needsReminder(rent(), [], '2026-09-26'), 'on the day');
  assert.ok(needsReminder(rent(), [], '2026-09-29'), 'still owed');
  assert.equal(needsReminder(rent(), [pay()], '2026-09-26'), null, 'paid');
  assert.equal(needsReminder(rent({ active: 0 }), [], '2026-09-26'), null, 'inactive');
  assert.equal(needsReminder(rent({ kind: 'loan' }), [], '2026-09-26'), null, 'loans have no monthly due date');
});
