/**
 * The shared component kit. Styling is Tailwind utilities over the tokens in
 * tokens.css, so light and dark come for free and no component carries a
 * `dark:` variant. Seeded from godhome's kit, restyled to the Vercel/Geist
 * tokens: hairline borders, flat surfaces, the foreground as the accent.
 */
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useThemeChoice, type ThemeChoice } from "./theme";

export * from "./theme";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ── controls ────────────────────────────────────────────────────────────────

// default/primary/ghost carry the work. The filled colours exist because a
// start/stop/save control reads faster in colour than in black and white; reach
// for them sparingly, and never to decorate.
type Variant = "default" | "primary" | "danger" | "destructive" | "success" | "warn" | "on" | "ghost";
const VARIANT: Record<Variant, string> = {
  default: "bg-surface border-line text-fg hover:bg-surface1",
  primary: "bg-accent border-accent text-on-color hover:opacity-85",
  /** Outlined: a delete that still needs confirming. */
  danger: "bg-surface text-red border-[color-mix(in_srgb,var(--red)_40%,var(--border))] hover:bg-[color-mix(in_srgb,var(--red)_10%,transparent)]",
  /** Filled red: the confirmed destructive action, or stop. */
  destructive: "bg-red border-red text-on-color hover:opacity-85",
  success: "bg-green border-green text-on-color hover:opacity-85",
  warn: "bg-amber border-amber text-on-color hover:opacity-85",
  on: "bg-surface2 border-line text-fg",
  ghost: "bg-transparent border-transparent text-fg2 hover:bg-surface1 hover:text-fg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  /** A danger button clicked once, waiting for the second click. */
  armed?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", armed, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-40 pointer-coarse:min-h-10",
        size === "md" ? "min-h-8 px-2.5 py-1.5 text-sm" : "min-h-0 px-2 py-0.5 text-xs",
        armed ? "border-red bg-red text-on-color" : VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});

const FIELD =
  "w-full min-h-8 rounded-md border border-line bg-bg2 px-2 py-1.5 text-sm text-fg placeholder:text-fg3 pointer-coarse:min-h-10";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(FIELD, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(FIELD, "min-h-[120px] resize-y leading-normal", className)} {...rest} />;
});

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx("min-h-8 cursor-pointer rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg pointer-coarse:min-h-10", className)}
      {...rest}
    />
  );
}

/** On/off switch. Use for a setting that applies immediately. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[22px] w-10 shrink-0 cursor-pointer rounded-full border p-0 transition-colors disabled:cursor-default disabled:opacity-40",
        checked ? "border-accent bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]" : "border-line bg-surface2",
      )}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full transition-all", checked ? "left-5 bg-accent" : "left-0.5 bg-fg3")} />
    </button>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cx("mb-1 block text-[10px] tracking-[.6px] text-fg3 uppercase", className)}>{children}</label>;
}

/** Label + control, stacked, with the standard gap below. */
export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2">
      <Label>{label}</Label>
      {children}
      {hint && <div className="mt-1 text-xs text-fg3">{hint}</div>}
    </div>
  );
}

// ── layout & text ───────────────────────────────────────────────────────────

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <header className={cx("flex flex-none flex-wrap items-center gap-2 border-b border-line bg-bg1 px-3 py-2", className)}>
      {children}
    </header>
  );
}

export function Spacer() {
  return <span className="ml-auto" />;
}

/** The scrolling body of a tab or page. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("min-h-0 flex-1 overflow-y-auto p-[18px] max-md:px-2.5 max-md:py-3", className)}>{children}</div>;
}

export function H2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={cx("mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[.08em] text-fg3 uppercase", className)}>
      {children}
    </h2>
  );
}

export function Mini({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("text-xs text-fg2", className)} {...rest}>
      {children}
    </span>
  );
}

type Tone = "idle" | "running" | "passed" | "failed" | "not-reached" | "stopped";
const TONE_BORDER: Record<Tone, string> = {
  idle: "border-l-fg3",
  running: "border-l-amber",
  passed: "border-l-green",
  failed: "border-l-red",
  "not-reached": "border-l-line",
  stopped: "border-l-orange",
};
const TONE_TEXT: Record<Tone, string> = {
  idle: "text-fg3",
  running: "text-amber",
  passed: "text-green",
  failed: "text-red",
  "not-reached": "text-fg3",
  stopped: "text-orange",
};
export type { Tone };

export function toneText(tone: Tone): string {
  return TONE_TEXT[tone];
}

export function Card({ children, tone, className, ...rest }: HTMLAttributes<HTMLDivElement> & { tone?: Tone }) {
  return (
    <div
      className={cx("mb-2 rounded-lg border border-line bg-surface px-3 py-2.5", tone && cx("border-l-[3px]", TONE_BORDER[tone]), className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A headline number with a label, for dashboards. */
export function StatTile({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3.5", className)}>
      <div className="text-[.72rem] tracking-[.08em] text-fg3 uppercase">{label}</div>
      <div className="truncate text-2xl leading-tight font-semibold">{value}</div>
      {sub && <div className="line-clamp-2 text-[.8rem] text-fg2">{sub}</div>}
    </div>
  );
}

/** A small uppercase state pill: RUNNING, PASSED, FAILED… */
export function StatePill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx("rounded-md border border-current px-1.5 py-px text-[11px] tracking-[.5px] uppercase", TONE_TEXT[tone])}
      style={{ background: "color-mix(in srgb, currentColor 12%, transparent)" }}
    >
      {children}
    </span>
  );
}

export function Chip({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  return (
    <span
      title={title}
      onClick={onClick}
      className={cx(
        "mt-0.5 mr-1 inline-block rounded-full border border-line bg-surface2 px-2 py-px text-[10.5px] text-fg2",
        onClick && "cursor-pointer hover:border-red hover:text-red",
      )}
    >
      {children}
    </span>
  );
}

export function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cx("m-0 max-h-[220px] overflow-auto rounded-md border border-line bg-bg1 p-2 text-xs whitespace-pre-wrap", className)}>
      {children}
    </pre>
  );
}

export function Badge({ n }: { n: number }) {
  if (!(n > 0)) return null;
  return <span className="ml-auto min-w-4 rounded-lg bg-red px-1 text-center text-[10px] leading-4 text-on-color">{n > 99 ? "99+" : n}</span>;
}

// ── states ──────────────────────────────────────────────────────────────────

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-10 text-center text-fg3">{children}</div>;
}

export function Loading({ msg = "loading…" }: { msg?: string }) {
  return <Empty>{msg}</Empty>;
}

export function ErrorState({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="p-10 text-center text-red">
      {msg}
      {onRetry && (
        <div className="mt-3">
          <Button onClick={onRetry}>Retry</Button>
        </div>
      )}
    </div>
  );
}

/** "⚠ retrying — showing data from 14:02" when a poll fell back to the last good payload. */
export function StaleBadge({ stale, at }: { stale: boolean; at?: number }) {
  if (!stale) return null;
  return <span className="text-xs text-amber">⚠ retrying — showing data from {at ? new Date(at).toLocaleTimeString() : "earlier"}</span>;
}

const DOT: Record<string, string> = {
  ok: "bg-green",
  passed: "bg-green",
  running: "bg-amber animate-pulse",
  failed: "bg-red",
  error: "bg-red",
  warn: "bg-amber",
  stopped: "bg-orange",
  idle: "bg-fg3",
};
export function StatusDot({ state, title }: { state: string; title?: string }) {
  return <span title={title ?? state} className={cx("inline-block size-2 shrink-0 rounded-full", DOT[state] ?? "bg-fg3")} />;
}

// ── overlays ────────────────────────────────────────────────────────────────

/** Closes on Escape and on a click on the backdrop. */
export function Modal({
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "flex max-h-[90vh] w-full flex-col rounded-lg border border-line bg-surface shadow-[0_4px_12px_rgba(0,0,0,.08)]",
          wide ? "max-w-4xl" : "max-w-lg",
        )}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <b className="text-fg">{title}</b>
          <Spacer />
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="close">
            ✕
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

/** Two-step confirmation for anything destructive — replaces window.confirm. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = "Delete",
  danger = true,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={busy}
            autoFocus
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** A button that opens a popover menu; closes on outside click and Escape. */
export function Menu({ label, children, align = "left", title }: { label: ReactNode; children: ReactNode; align?: "left" | "right"; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex">
      <Button title={title} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
      </Button>
      {open && (
        <div
          className={cx(
            "absolute top-[calc(100%+4px)] z-[60] flex min-w-[196px] flex-col gap-1 rounded-lg border border-line bg-surface p-2 shadow-[0_4px_12px_rgba(0,0,0,.08)] [&>button]:w-full [&>button]:justify-start [&>select]:w-full",
            align === "right" ? "right-0" : "left-0",
          )}
          onClick={(e) => (e.target as HTMLElement).closest("button") && setOpen(false)}
          // A picker inside the menu closes it too: choosing a role or a skill
          // IS the action, so leaving the menu open after it would be one
          // pointless click before anything else can be done.
          onChange={(e) => (e.target as HTMLElement).tagName === "SELECT" && setOpen(false)}
        >
          {children}
        </div>
      )}
    </span>
  );
}

export function MenuSep() {
  return <span className="my-1 h-px bg-line" />;
}

/** Collapsible section with a clickable header. */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="mb-2">
      <summary className="cursor-pointer select-none">{summary}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

// ── theme ───────────────────────────────────────────────────────────────────

const THEME_ICON: Record<ThemeChoice, string> = {
  light: "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  dark: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z",
  system: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
};
const THEME_LABEL: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };

/** Segmented Light / Dark / System control. */
export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [choice, set] = useThemeChoice();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md border border-line bg-bg1 p-0.5">
      {(["light", "dark", "system"] as const).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={choice === c}
          title={THEME_LABEL[c]}
          onClick={() => set(c)}
          className={cx(
            "flex cursor-pointer items-center gap-1.5 rounded border-none px-2 py-1 text-xs",
            choice === c ? "bg-surface2 text-fg" : "bg-transparent text-fg3 hover:text-fg",
          )}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d={THEME_ICON[c]} />
          </svg>
          {!compact && THEME_LABEL[c]}
        </button>
      ))}
    </div>
  );
}
