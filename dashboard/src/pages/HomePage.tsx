import { Link } from "react-router-dom";
import { useOverview } from "../hooks/useOverview";
import { useGoals } from "../hooks/useGoals";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useModuleVisible } from "../hooks/useSettings";
import { fmtMin, timeToMin, nowMin } from "../lib/utils";
import type { OverviewResponse } from "../types";
import { cur } from "../lib/currency";

// Home is a grid of summary widgets. Each one shows the headline numbers for one
// section and links to that section's page, which holds the full UI.

const card = "flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3.5 text-fg no-underline";
const title = "text-[.72rem] uppercase tracking-[.08em] text-fg3";
const sub = "line-clamp-2 text-[.8rem] text-fg2";

interface WidgetProps {
  to: string;
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}

function Widget({ to, title: heading, value, sub: subline, children }: WidgetProps) {
  const visible = useModuleVisible();
  if (!visible(to)) return null;
  return (
    <Link to={to} className={`${card} transition-colors hover:border-accent hover:bg-surface1`}>
      <div className={title}>{heading}</div>
      <div className="truncate text-2xl leading-tight font-semibold">{value}</div>
      {subline && <div className={sub}>{subline}</div>}
      {children}
    </Link>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="my-1 h-1.5 overflow-hidden rounded-sm bg-surface2">
      <div className="h-full rounded-sm bg-accent transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1.5 flex list-none flex-col gap-0.5 p-0">
      {items.map((t, i) => (
        <li key={i} className="truncate text-[.8rem] text-fg1 before:mr-1.5 before:text-fg3 before:content-['•']">{t}</li>
      ))}
    </ul>
  );
}

function nextScheduleItem(o: OverviewResponse) {
  const now = nowMin();
  return o.schedule.find((s) => timeToMin(s.time) >= now) ?? null;
}

const SHORTCUTS: { to: string; label: string }[] = [
  { to: "/money", label: "Loans" },
  { to: "/whatsapp", label: "WhatsApp" },
  { to: "/instagram", label: "Instagram" },
  { to: "/chat", label: "Chat" },
  { to: "/shop", label: "Shop" },
  { to: "/projects", label: "Projects" },
  { to: "/media", label: "Media" },
  { to: "/transcripts", label: "Transcripts" },
  { to: "/content", label: "Content" },
  { to: "/trends", label: "Trends" },
  { to: "/chat-analytics", label: "Analytics" },
  { to: "/server", label: "Server" },
];

const AREA_COLOR = { work: "text-accent", personal: "text-green", learn: "text-amber" } as const;

interface DueItem {
  id: number; name: string; kind: "bill" | "loan"; amount: number; currency: string;
  status: { dueDate: string; paid: boolean; daysUntilDue: number; overdue: boolean } | null;
}

/** Bills due in the next week or already overdue, soonest first. */
function useDueSoon() {
  const { data } = useQuery<{ items: DueItem[] }>({
    queryKey: ["obligations"],
    queryFn: () => api("/api/obligations"),
    refetchInterval: 300_000,
  });
  return (data?.items ?? [])
    .filter((i) => i.kind === "bill" && i.status && !i.status.paid && i.status.daysUntilDue <= 7)
    .sort((a, b) => a.status!.daysUntilDue - b.status!.daysUntilDue);
}

export default function HomePage() {
  const { data: o, isLoading, error } = useOverview();
  const dueSoon = useDueSoon();
  const { data: goals } = useGoals();
  const visible = useModuleVisible();

  if (isLoading) return <div className="p-5 text-center text-[.85rem] text-fg3">Loading...</div>;
  if (error || !o) {
    return <div className="p-5 text-center text-[.85rem] text-fg3">Could not load the overview{error ? `: ${error.message}` : ""}</div>;
  }

  const adhkarDone = Object.values(o.deen.adhkar).filter(Boolean).length;
  const habitsPct = o.habits.totalCount ? (o.habits.completedCount / o.habits.totalCount) * 100 : 0;
  const next = nextScheduleItem(o);
  const lastJournal = o.journal[0];
  const topGoals = (goals ?? []).slice(0, 3);
  const unsorted = o.tasks.active.filter((t) => !t.area).length;

  return (
    <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
      <Widget
        to="/deen"
        title="Next prayer"
        value={o.nextPrayer ? o.nextPrayer.name : "--"}
        sub={o.nextPrayer ? `${o.nextPrayer.time} · in ${fmtMin(o.nextPrayer.minutesUntil)}` : "No prayer times"}
      />

      <Widget to="/tasks" title="Tasks" value={o.tasks.count} sub={`active · ${o.tasks.completedToday.length} done today`}>
        <List items={o.tasks.active.slice(0, 3).map((t) => t.title)} />
      </Widget>

      {visible("/tasks") && (
        <div className={card}>
          <div className={title}>Open tasks by area</div>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {(["work", "personal", "learn"] as const).map((a) => (
              <Link key={a} to={`/tasks?area=${a}`}
                className={`flex flex-col items-center rounded-lg border border-line bg-surface2 px-1 py-2 text-xs capitalize no-underline hover:border-current ${AREA_COLOR[a]}`}>
                <strong className="text-xl leading-tight">{o.tasks.active.filter((t) => t.area === a).length}</strong>
                <span>{a}</span>
              </Link>
            ))}
          </div>
          {unsorted > 0 && <Link to="/tasks?area=none" className={sub}>{unsorted} unsorted</Link>}
        </div>
      )}

      <Widget
        to="/work"
        title="Work today"
        value={fmtMin(o.work.totalMinutes)}
        sub={o.work.activeSession
          ? `Running: ${o.work.activeSession.project_name ?? o.work.activeSession.work_type} · ${fmtMin(o.work.activeSession.minutes_active)}`
          : `Break ${fmtMin(o.work.breakMinutes)} · not running`}
      />

      <Widget to="/habits" title="Habits" value={`${o.habits.completedCount}/${o.habits.totalCount}`} sub="done today">
        <Bar pct={habitsPct} />
      </Widget>

      <Widget
        to="/deen"
        title="Deen"
        value={`${adhkarDone}/4 adhkar`}
        sub={`Quran: ${o.deen.quranToday} pages today · ${o.deen.quranTotal} total`}
      />

      <Widget
        to="/finance"
        title="Income this month"
        value={`${(o.finance.monthTotal || 0).toLocaleString()} ${cur()}`}
        sub={`Dev ${(o.finance.monthDevIncome || 0).toLocaleString()} · Shop ${(o.finance.monthShopRevenue || 0).toLocaleString()}`}
      />

      <Widget to="/schedule" title="Next on schedule" value={next ? next.time : "--"} sub={next ? next.title : "Nothing else today"} />

      <Widget to="/goals" title="Goals" value={goals ? goals.length : "--"} sub="active">
        {topGoals.map((g) => (
          <div key={g.id} className="mt-1 text-[.78rem] text-fg1">
            <span className="block truncate">{g.title}</span>
            <Bar pct={g.progress} />
          </div>
        ))}
      </Widget>

      {visible("/money") && dueSoon.length > 0 && (
        <Link to="/money" className={`${card} transition-colors hover:border-accent hover:bg-surface1`}>
          <div className={title}>To pay</div>
          <div className="truncate text-2xl leading-tight font-semibold">
            {dueSoon.reduce((n, i) => n + i.amount, 0).toLocaleString()} {cur()}
          </div>
          <ul className="mt-1.5 flex list-none flex-col gap-0.5 p-0">
            {dueSoon.slice(0, 3).map((i) => (
              <li key={i.id} className="flex gap-2 truncate text-[.8rem]">
                <span className="min-w-0 flex-1 truncate text-fg1">{i.name}</span>
                <span className={i.status!.overdue ? "text-red" : i.status!.daysUntilDue <= 3 ? "text-amber" : "text-fg2"}>
                  {i.status!.overdue ? `${-i.status!.daysUntilDue}d late` : i.status!.daysUntilDue === 0 ? "today" : `${i.status!.daysUntilDue}d`}
                </span>
              </li>
            ))}
          </ul>
        </Link>
      )}

      <Widget
        to="/journal"
        title="Journal"
        value={lastJournal?.mood ?? (lastJournal ? "Last entry" : "--")}
        sub={lastJournal ? lastJournal.entry.slice(0, 90) + (lastJournal.entry.length > 90 ? "..." : "") : "No entries yet"}
      />

      <div className={`${card} col-span-full`}>
        <div className={title}>More</div>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {SHORTCUTS.filter((s) => visible(s.to)).map((s) => (
            <Link key={s.to} to={s.to}
              className="rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[.82rem] text-fg1 no-underline hover:border-accent hover:text-accent">
              {s.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
