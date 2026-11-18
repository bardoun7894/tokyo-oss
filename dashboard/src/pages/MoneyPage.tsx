import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Select, Empty, Card } from "@bardouni/ui";
import { api, postApi, patchApi, deleteApi } from "../api/client";
import { useToast } from "../components/ui/Toast";

// What is owed: recurring bills (rent on the 26th) and loans with a balance.
// The dates and balances are computed on the server (src/obligations.ts).

interface Payment {
  id: number; amount: number; paid_at: string; period: string | null; proof_path: string | null; note: string | null;
}
interface Obligation {
  id: number; name: string; kind: "bill" | "loan"; counterparty: string | null;
  amount: number; currency: string; due_day: number | null; principal: number | null; notes: string | null;
  payments: Payment[];
  status: { period: string; dueDate: string; paid: boolean; daysUntilDue: number; overdue: boolean } | null;
  loan: { principal: number; paid: number; remaining: number; progress: number; lastPaidAt: string | null } | null;
}

const KEY = ["obligations"] as const;
const money = (n: number, c: string) => `${Math.round(n).toLocaleString()} ${c}`;
/** 0 means "not set yet" — better to say so than to show a number nobody entered. */
const amountOrUnset = (n: number, c: string) => (n > 0 ? money(n, c) : "amount not set");

function dueLabel(s: NonNullable<Obligation["status"]>): { text: string; cls: string } {
  if (s.overdue) return { text: `${-s.daysUntilDue} day${s.daysUntilDue === -1 ? "" : "s"} overdue`, cls: "text-red" };
  if (s.daysUntilDue === 0) return { text: "due today", cls: "text-amber" };
  if (s.daysUntilDue <= 3) return { text: `in ${s.daysUntilDue} days`, cls: "text-amber" };
  return { text: `in ${s.daysUntilDue} days`, cls: "text-fg2" };
}

function PayForm({ o, onDone }: { o: Obligation; onDone: () => void }) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(String(o.amount || ""));
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [proof, setProof] = useState("");

  const pay = useMutation({
    mutationFn: () => postApi(`/api/obligations/${o.id}/pay`, {
      amount: Number(amount), paidAt, proofPath: proof.trim() || undefined,
      period: o.kind === "bill" ? o.status?.period : undefined,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEY }); showToast("Payment recorded", "success"); onDone(); },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-2">
      <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Amount ({o.currency})
        <Input className="w-[110px]" type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Paid on
        <Input className="w-[150px]" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
      </label>
      <label className="flex flex-1 flex-col gap-1 text-[.72rem] text-fg3">Proof (WhatsApp photo path, optional)
        <Input placeholder="whatsapp-media/wa_76120_...jpg" value={proof} onChange={(e) => setProof(e.target.value)} />
      </label>
      <Button variant="success" disabled={pay.isPending || !Number(amount)} onClick={() => pay.mutate()}>Record</Button>
      <Button variant="ghost" onClick={onDone}>Cancel</Button>
    </div>
  );
}

function PaymentRow({ p, currency, onDelete }: { p: Payment; currency: string; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-2 border-t border-line py-1 text-[.8rem]">
      <span className="w-[92px] shrink-0 text-fg3">{p.paid_at}</span>
      <span className="w-[100px] shrink-0 font-semibold">{money(p.amount, currency)}</span>
      {p.period && <span className="shrink-0 rounded bg-surface2 px-2 py-0.5 text-[.7rem] text-fg2">{p.period}</span>}
      <span className="min-w-0 flex-1 truncate text-fg2">{p.note ?? ""}</span>
      {p.proof_path && (
        <a href={`/api/media/${p.proof_path.split("/").pop()}`} target="_blank" rel="noreferrer" className="shrink-0 text-[.75rem] text-accent">proof</a>
      )}
      <Button variant="ghost" size="sm" onClick={onDelete} title="Remove this payment">✕</Button>
    </div>
  );
}

function EditForm({ o, onDone }: { o: Obligation; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [name, setName] = useState(o.name);
  const [counterparty, setCounterparty] = useState(o.counterparty ?? "");
  const [amount, setAmount] = useState(o.amount ? String(o.amount) : "");
  const [dueDay, setDueDay] = useState(o.due_day ? String(o.due_day) : "");
  const [principal, setPrincipal] = useState(o.principal ? String(o.principal) : "");

  const save = useMutation({
    mutationFn: () => patchApi(`/api/obligations/${o.id}`, {
      name, counterparty, amount,
      ...(o.kind === "bill" ? { dueDay: Number(dueDay) } : { principal }),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEY }); showToast("Saved", "success"); onDone(); },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-2">
      <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[.72rem] text-fg3">Name
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[.72rem] text-fg3">To whom
        <Input className="w-[140px]" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[.72rem] text-fg3">{o.kind === "bill" ? "Amount / month" : "Instalment"}
        <Input className="w-[120px]" type="number" step="any" placeholder="not set" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      {o.kind === "bill" ? (
        <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Day
          <Input className="w-[80px]" type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Total owed
          <Input className="w-[130px]" type="number" step="any" placeholder="not set" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
        </label>
      )}
      <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      <Button variant="ghost" onClick={onDone}>Cancel</Button>
    </div>
  );
}

function ObligationCard({ o }: { o: Obligation }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (id: number) => deleteApi(`/api/obligations/payments/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEY }); showToast("Payment removed", "success"); },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  const due = o.status ? dueLabel(o.status) : null;

  return (
    <Card className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{o.name}</div>
          <div className="text-[.78rem] text-fg3">
            {o.counterparty ? `${o.counterparty} · ` : ""}
            {o.kind === "bill" ? `every month on the ${o.due_day}${o.due_day === 1 ? "st" : o.due_day === 2 ? "nd" : o.due_day === 3 ? "rd" : "th"}` : "loan"}
          </div>
        </div>
        {o.kind === "bill" && o.status && (
          <div className="text-right">
            <div className="font-semibold">{amountOrUnset(o.amount, o.currency)}</div>
            <div className={`text-[.78rem] ${due!.cls}`}>{o.status.dueDate} · {due!.text}</div>
          </div>
        )}
        {o.kind === "loan" && o.loan && (
          <div className="text-right">
            <div className="font-semibold">
              {o.loan.principal > 0
                ? <>{money(o.loan.remaining, o.currency)} <span className="text-[.75rem] font-normal text-fg3">left</span></>
                : <>{money(o.loan.paid, o.currency)} <span className="text-[.75rem] font-normal text-fg3">paid</span></>}
            </div>
            <div className="text-[.78rem] text-fg3">
              {o.loan.principal > 0 ? `${money(o.loan.paid, o.currency)} of ${money(o.loan.principal, o.currency)}` : "total owed not set"}
            </div>
          </div>
        )}
        <Button size="sm" onClick={() => setPaying(!paying)}>{paying ? "Close" : "Record payment"}</Button>
        <Button variant="ghost" size="sm" title="Edit" onClick={() => setEditing(!editing)}>✎</Button>
      </div>

      {o.kind === "loan" && o.loan && o.loan.principal > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-surface2">
          <div className="h-full rounded-sm bg-green transition-[width] duration-500" style={{ width: `${o.loan.progress}%` }} />
        </div>
      )}

      {editing && <EditForm o={o} onDone={() => setEditing(false)} />}
      {paying && <PayForm o={o} onDone={() => setPaying(false)} />}

      {o.payments.length > 0 && (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen(!open)} className="cursor-pointer border-none bg-transparent p-0 text-[.75rem] text-fg3 hover:text-fg">
            {open ? "Hide" : `${o.payments.length} payment${o.payments.length === 1 ? "" : "s"}`}
          </button>
          {open && o.payments.map((p) => (
            <PaymentRow key={p.id} p={p} currency={o.currency} onDelete={() => remove.mutate(p.id)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function AddForm() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [kind, setKind] = useState<"bill" | "loan">("bill");
  const [name, setName] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDay, setDueDay] = useState("26");
  const [principal, setPrincipal] = useState("");

  const create = useMutation({
    mutationFn: () => postApi("/api/obligations", {
      name, kind, counterparty, amount: amount || undefined,
      dueDay: kind === "bill" ? Number(dueDay) : undefined,
      principal: kind === "loan" ? principal || undefined : undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY });
      showToast("Added", "success");
      setName(""); setCounterparty(""); setAmount(""); setPrincipal("");
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Type
          <Select value={kind} onChange={(e) => setKind(e.target.value as "bill" | "loan")}>
            <option value="bill">Monthly bill</option>
            <option value="loan">Loan</option>
          </Select>
        </label>
        <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-[.72rem] text-fg3">Name
          <Input placeholder={kind === "bill" ? "كراء" : "Shop loan"} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[.72rem] text-fg3">To whom
          <Input className="w-[140px]" placeholder="Hind" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[.72rem] text-fg3">{kind === "bill" ? "Amount / month" : "Instalment"}
          <Input className="w-[120px]" type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {kind === "bill" ? (
          <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Day of month
            <Input className="w-[90px]" type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-[.72rem] text-fg3">Total owed
            <Input className="w-[120px]" type="number" step="any" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
          </label>
        )}
        <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add</Button>
      </div>
    </Card>
  );
}

export default function MoneyPage() {
  const { data, isLoading, error } = useQuery<{ today: string; items: Obligation[] }>({
    queryKey: KEY,
    queryFn: () => api("/api/obligations"),
    refetchInterval: 300_000,
  });

  const bills = data?.items.filter((o) => o.kind === "bill") ?? [];
  const loans = data?.items.filter((o) => o.kind === "loan") ?? [];
  const owedThisMonth = bills.filter((o) => !o.status?.paid).reduce((n, o) => n + o.amount, 0);
  const loansLeft = loans.reduce((n, o) => n + (o.loan?.remaining ?? 0), 0);

  return (
    <div className="max-w-[900px]">
      <h2 className="mb-1 text-xl font-semibold text-fg">Loans &amp; bills</h2>
      <p className="mb-4 text-[.8rem] text-fg3">
        What is owed. Bills repeat every month on their day; loans count down as you pay them.
        A reminder goes to Telegram two days before, on the day, and while one stays unpaid.
      </p>

      {isLoading && <div className="p-5 text-center text-[.85rem] text-fg3">Loading...</div>}
      {error && <div className="text-[.8rem] text-red">Could not load: {error.message}</div>}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap gap-3">
            <div className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="text-[.72rem] tracking-[.08em] text-fg3 uppercase">Still to pay this month</div>
              <div className="text-2xl font-semibold">{owedThisMonth.toLocaleString()} DH</div>
            </div>
            <div className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="text-[.72rem] tracking-[.08em] text-fg3 uppercase">Loans outstanding</div>
              <div className="text-2xl font-semibold">{Math.round(loansLeft).toLocaleString()} DH</div>
            </div>
          </div>

          <AddForm />

          <h3 className="mb-2 text-[.8rem] tracking-[.08em] text-fg3 uppercase">Monthly bills</h3>
          {bills.length === 0 ? <Empty>No bills yet</Empty> : bills.map((o) => <ObligationCard key={o.id} o={o} />)}

          <h3 className="mt-5 mb-2 text-[.8rem] tracking-[.08em] text-fg3 uppercase">Loans</h3>
          {loans.length === 0 ? <Empty>No loans yet</Empty> : loans.map((o) => <ObligationCard key={o.id} o={o} />)}
        </>
      )}
    </div>
  );
}
