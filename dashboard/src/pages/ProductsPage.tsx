import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, Select as UiSelect } from "@bardouni/ui";
import { fetchBatches, fetchProducts, fetchStats, patchProduct, syncProducts } from "../api/products";
import { capSelection, DEFAULT_PAGE_SIZE, formatStatsLine, MAX_FORWARD_SELECTION, type Product, type ProductsStats, type SortOrder, type BatchSummary } from "../lib/products";
import { useToast } from "../components/ui/Toast";
import ProductCard from "../components/products/ProductCard";
import BatchReviewModal from "../components/products/BatchReviewModal";
import ForwardModal from "../components/products/ForwardModal";

const SORT_OPTIONS: Array<{ value: SortOrder; label: string }> = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "name_asc", label: "Name: A–Z" },
  { value: "name_desc", label: "Name: Z–A" },
];

/** Debounce a fast-changing value so we don't refetch on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function ProductsPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  // Filters
  const [sort, setSort] = useState<SortOrder>("date_desc");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 350);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [unpricedOnly, setUnpricedOnly] = useState(false);
  const [pricedOnly, setPricedOnly] = useState(false);

  // Data
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState<ProductsStats | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [syncing, setSyncing] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  // Selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const lastIndexRef = useRef<number | null>(null);

  // Modals
  const [reviewBatchId, setReviewBatchId] = useState<string | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);

  const loadStats = useCallback(() => {
    fetchStats().then(setStats).catch(() => setStats(null));
  }, []);

  const loadBatches = useCallback(() => {
    fetchBatches()
      .then((r) => setBatches(r.batches || []))
      .catch(() => setBatches([]));
  }, []);

  useEffect(() => { loadStats(); loadBatches(); }, [loadStats, loadBatches]);

  async function handleSync() {
    setSyncing(true);
    try {
      const r = await syncProducts();
      showToast(`Synced: ${r.added.toLocaleString("en-US")} added · ${r.paired.toLocaleString("en-US")} paired · ${r.unpriced.toLocaleString("en-US")} unpriced`, "success");
      loadStats();
      loadBatches();
      loadPage(0, true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Sync failed", "error");
    } finally {
      setSyncing(false);
    }
  }

  const loadPage = useCallback((offset: number, reset: boolean) => {
    const req = ++reqRef.current;
    setLoading(true);
    fetchProducts({
      sort,
      q: debouncedSearch || undefined,
      min: minPrice || (pricedOnly ? "0.01" : undefined),
      max: maxPrice || undefined,
      unpriced: unpricedOnly,
      limit: DEFAULT_PAGE_SIZE,
      offset,
    })
      .then((r) => {
        if (req !== reqRef.current) return;
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setTotal(r.total);
        setDone(offset + r.items.length >= r.total || r.items.length === 0);
      })
      .catch((err: Error) => {
        if (req === reqRef.current) showToast(err.message || "Failed to load products", "error");
      })
      .finally(() => { if (req === reqRef.current) setLoading(false); });
  }, [sort, debouncedSearch, minPrice, maxPrice, unpricedOnly, pricedOnly, showToast]);

  // Reset + reload whenever a filter changes
  useEffect(() => {
    setItems([]);
    setDone(false);
    setSelected(new Set());
    lastIndexRef.current = null;
    loadPage(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, debouncedSearch, minPrice, maxPrice, unpricedOnly, pricedOnly]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && !done) loadPage(items.length, false);
    }, { rootMargin: "600px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, done, items.length, loadPage]);

  function toggleUnpricedOnly() {
    setUnpricedOnly((v) => !v);
    setPricedOnly(false);
  }
  function togglePricedOnly() {
    setPricedOnly((v) => !v);
    setUnpricedOnly(false);
  }

  function selectCard(id: number, index: number, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndexRef.current !== null) {
        const [from, to] = [lastIndexRef.current, index].sort((a, b) => a - b);
        for (let i = from; i <= to; i++) {
          const it = items[i];
          if (it) next.add(it.id);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastIndexRef.current = index;
  }

  async function savePrice(id: number, price: number) {
    const prevItems = items;
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, price, priceSource: "manual", confidence: "high" } : it)));
    try {
      await patchProduct(id, { price });
      loadStats();
    } catch (err) {
      setItems(prevItems);
      showToast(err instanceof Error ? err.message : "Failed to save price", "error");
    }
  }

  const selectedItems = useMemo(() => items.filter((it) => selected.has(it.id)), [items, selected]);
  const selectedTotal = selectedItems.reduce((s, it) => s + (it.price ?? 0), 0);
  const needsReview = batches.filter((b) => b.confidence === "low" || b.unpriced > 0);

  const capped = capSelection([...selected], MAX_FORWARD_SELECTION);

  return (
    <div className="max-w-[1400px]">
      <a onClick={() => navigate("/")} className="mb-4 inline-flex cursor-pointer items-center gap-1.5 text-[.85rem] text-fg3 hover:text-accent">
        &larr; Back to Dashboard
      </a>
      <h2 className="mb-3 text-[1.3rem] font-semibold text-fg">Product Catalog</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {stats && (
          <div className="text-[.85rem] text-fg2">
            {formatStatsLine(stats.total, stats.priced, stats.unpriced)}
            {stats.lowConfidence > 0 && <span className="ml-2 text-fg3">· {stats.lowConfidence.toLocaleString("en-US")} to double-check</span>}
          </div>
        )}
        <Button size="sm" onClick={() => void handleSync()} disabled={syncing} className="ml-auto">
          {syncing ? "Syncing…" : "Sync"}
        </Button>
      </div>

      {needsReview.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber bg-[color-mix(in_srgb,var(--amber)_8%,transparent)] p-2.5 text-[.82rem]">
          <span className="text-amber">
            {needsReview.length} batch{needsReview.length === 1 ? "" : "es"} need{needsReview.length === 1 ? "s" : ""} review
          </span>
          <div className="flex flex-wrap gap-1.5">
            {needsReview.slice(0, 8).map((b) => (
              <button
                key={b.batchId}
                type="button"
                onClick={() => setReviewBatchId(b.batchId)}
                className="rounded-md border border-line bg-surface px-2 py-1 text-[.75rem] text-fg2 hover:border-amber hover:text-fg"
              >
                {b.date} ({b.imageCount} img{b.unpriced > 0 ? `, ${b.unpriced} unpriced` : ""})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <UiSelect value={sort} onChange={(e) => setSort(e.target.value as SortOrder)} className="min-w-[160px]">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </UiSelect>
        <Input
          placeholder="Search title or brand…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[160px] flex-1 sm:max-w-[240px]"
        />
        <Input type="number" placeholder="Min DH" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} className="w-24" />
        <Input type="number" placeholder="Max DH" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className="w-24" />
        <Button size="sm" variant={unpricedOnly ? "primary" : "default"} onClick={toggleUnpricedOnly}>
          Unpriced only
        </Button>
        <Button size="sm" variant={pricedOnly ? "primary" : "default"} onClick={togglePricedOnly}>
          Priced only
        </Button>
        <Button
          size="sm"
          onClick={() => setSelected(new Set(items.map((it) => it.id)))}
          disabled={items.length === 0}
          title="Selects every product currently loaded on screen for this filter -- scroll to load more before selecting all"
        >
          Select all loaded ({items.length.toLocaleString("en-US")})
        </Button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 pb-24 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
        {items.map((p, i) => (
          <ProductCard
            key={p.id}
            product={p}
            selected={selected.has(p.id)}
            onClick={(e) => selectCard(p.id, i, e.shiftKey)}
            onSavePrice={savePrice}
          />
        ))}
      </div>

      {!loading && items.length === 0 && <div className="py-10 text-center text-fg3">No products match these filters.</div>}
      {loading && <div className="py-6 text-center text-fg3">Loading…</div>}
      <div ref={sentinelRef} className="h-px" />

      <div className="mt-2 text-[.75rem] text-fg3">
        Showing {items.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
      </div>

      {/* Sticky selection bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center gap-2 border-t border-line bg-bg1 px-3 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,.08)]">
          {/* Sidebar has a higher z-index (100) so it renders on top of this bar's left edge at every width -- no breakpoint math needed to dodge it. */}
          <span className="text-[.85rem] text-fg">
            {selected.size.toLocaleString("en-US")} selected · total {selectedTotal.toLocaleString("en-US")} DH
          </span>
          <span className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
            <Button size="sm" variant="primary" onClick={() => setForwardOpen(true)}>
              Forward{capped.truncated ? ` (first ${capped.ids.length})` : ""}
            </Button>
          </span>
        </div>
      )}

      {reviewBatchId && (
        <BatchReviewModal
          batchId={reviewBatchId}
          onClose={() => setReviewBatchId(null)}
          onSaved={() => { loadStats(); loadBatches(); loadPage(0, true); }}
        />
      )}

      {forwardOpen && (
        <ForwardModal
          ids={capped.ids}
          truncatedFrom={capped.truncated ? selected.size : undefined}
          onClose={() => setForwardOpen(false)}
          onSent={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}
