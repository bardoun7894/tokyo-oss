import { useState } from "react";
import { Input } from "@bardouni/ui";
import type { Product } from "../../lib/products";

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

interface ProductCardProps {
  product: Product;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onSavePrice: (id: number, price: number) => Promise<void>;
}

/**
 * A single product tile. ~98% of the catalog has no price on day one, so the
 * "no price" state is a first-class, calm badge -- not an error look -- and
 * the low-confidence marker is a subtle nudge to check, not a warning.
 */
export default function ProductCard({ product: p, selected, onClick, onSavePrice }: ProductCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(p.price ?? ""));
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) {
      setEditing(false);
      setDraft(String(p.price ?? ""));
      return;
    }
    setSaving(true);
    try {
      await onSavePrice(p.id, n);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // Don't let a click that started inside the price editor select/deselect the card.
        if (editing) return;
        onClick(e);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !editing) {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface transition-colors ${
        selected ? "border-accent ring-2 ring-accent/40" : "border-line hover:border-fg3"
      }`}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-surface2">
        <img
          src={p.thumb}
          alt={p.title}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
        <span
          className={`absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-full border text-[11px] ${
            selected ? "border-accent bg-accent text-on-color" : "border-line bg-bg1/80 text-transparent group-hover:text-fg3"
          }`}
          aria-hidden
        >
          {selected ? "✓" : ""}
        </span>
        {p.confidence === "low" && (
          <span
            className="absolute top-1.5 right-1.5 rounded-full border border-amber bg-bg1/90 px-1.5 py-px text-[10px] text-amber"
            title="Auto-paired with low confidence -- open the batch review to check it"
          >
            check price
          </span>
        )}
        <a
          href={p.full}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1.5 bottom-1.5 hidden rounded-md border border-line bg-bg1/90 px-1.5 py-0.5 text-[10px] text-fg2 group-hover:block pointer-coarse:block"
        >
          view
        </a>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-2">
        <div dir="auto" className="line-clamp-2 text-[.8rem] leading-tight font-medium text-fg" title={p.title}>
          {p.title}
        </div>
        {p.brand && (
          <div dir="auto" className="truncate text-[.7rem] text-fg3">
            {p.brand}
          </div>
        )}

        <div className="mt-1 flex items-center justify-between gap-2">
          {editing ? (
            <Input
              type="number"
              autoFocus
              min={1}
              step={1}
              value={draft}
              disabled={saving}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(String(p.price ?? ""));
                }
              }}
              onBlur={() => void save()}
              className="h-7 w-full text-[.8rem]"
            />
          ) : p.price !== null ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              className="rounded px-1 -mx-1 text-[.95rem] font-semibold text-fg hover:bg-surface2"
              title="Click to edit price"
            >
              {p.price} {p.currency}
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              className="rounded-full border border-line bg-surface2 px-2 py-0.5 text-[.7rem] text-fg3 hover:border-fg3 hover:text-fg2"
            >
              no price
            </button>
          )}
          <span className="shrink-0 text-[.65rem] text-fg3">{fmtDate(p.timestamp)}</span>
        </div>
      </div>
    </div>
  );
}
