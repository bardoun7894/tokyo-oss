import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Select as UiSelect } from "@bardouni/ui";
import { assignBatch, fetchBatchDetail } from "../../api/products";
import { shiftAssignments, type BatchDetail } from "../../lib/products";
import { useToast } from "../ui/Toast";

interface BatchReviewModalProps {
  batchId: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * The real, common failure this exists for: an off-by-N alignment between an
 * image burst and a price burst (e.g. 127 images vs 90 prices, one extra
 * photo at the start). The shift control is the primary affordance -- it
 * should fix the common case in one click, before anyone reaches for the
 * per-image dropdowns.
 */
export default function BatchReviewModal({ batchId, onClose, onSaved }: BatchReviewModalProps) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [shift, setShift] = useState(0);
  // Manual per-image overrides layered on top of the current shift.
  const [overrides, setOverrides] = useState<Record<number, number | null>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchBatchDetail(batchId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setShift(0);
        setOverrides({});
      })
      .catch((err: Error) => showToast(err.message || "Failed to load batch", "error"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [batchId, showToast]);

  const priceMessageIds = useMemo(() => (detail ? detail.prices.map((p) => p.messageId) : []), [detail]);
  const imageIds = useMemo(() => (detail ? detail.images.map((im) => im.id) : []), [detail]);

  const shifted = useMemo(
    () => (detail ? shiftAssignments(imageIds, priceMessageIds, shift) : []),
    [detail, imageIds, priceMessageIds, shift],
  );

  const priceByMessageId = useMemo(() => {
    const m = new Map<number, number>();
    detail?.prices.forEach((p) => m.set(p.messageId, p.value));
    return m;
  }, [detail]);

  function assignmentFor(productId: number): number | null {
    if (productId in overrides) return overrides[productId];
    return shifted.find((s) => s.productId === productId)?.priceMessageId ?? null;
  }

  async function save() {
    if (!detail) return;
    setSaving(true);
    try {
      const pairs = imageIds.map((productId) => ({ productId, priceMessageId: assignmentFor(productId) }));
      const { updated } = await assignBatch(batchId, pairs);
      showToast(`Assigned prices for ${updated} product${updated === 1 ? "" : "s"}`, "success");
      onSaved();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save batch", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Review batch ${batchId}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || loading || !detail}>
            {saving ? "Saving…" : "Save assignment"}
          </Button>
        </>
      }
    >
      {loading && <div className="p-6 text-center text-fg3">Loading batch…</div>}
      {!loading && detail && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface2 p-2.5">
            <span className="text-[.8rem] text-fg2">
              {imageIds.length} image{imageIds.length === 1 ? "" : "s"} · {priceMessageIds.length} price{priceMessageIds.length === 1 ? "" : "s"}
              {imageIds.length !== priceMessageIds.length && (
                <span className="ml-1 text-amber">(counts don&rsquo;t match -- shift to align)</span>
              )}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button size="sm" onClick={() => { setShift((s) => s - 1); setOverrides({}); }}>&larr; shift</Button>
              <span className="min-w-[70px] text-center text-[.8rem] tabular-nums">
                shift {shift > 0 ? `+${shift}` : shift}
              </span>
              <Button size="sm" onClick={() => { setShift((s) => s + 1); setOverrides({}); }}>shift &rarr;</Button>
              {(shift !== 0 || Object.keys(overrides).length > 0) && (
                <Button size="sm" variant="ghost" onClick={() => { setShift(0); setOverrides({}); }}>Reset</Button>
              )}
            </span>
          </div>

          <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
            {detail.images.map((im) => {
              const assigned = assignmentFor(im.id);
              const price = assigned !== null ? priceByMessageId.get(assigned) ?? null : null;
              return (
                <div key={im.id} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2">
                  <div className="aspect-square w-full overflow-hidden rounded bg-surface2">
                    <img src={im.thumb} alt={im.title} loading="lazy" className="size-full object-cover" />
                  </div>
                  <div dir="auto" className="line-clamp-1 text-[.7rem] text-fg3">{im.title}</div>
                  <UiSelect
                    value={assigned === null ? "" : String(assigned)}
                    onChange={(e) =>
                      setOverrides((prev) => ({
                        ...prev,
                        [im.id]: e.target.value === "" ? null : Number(e.target.value),
                      }))
                    }
                    className="w-full text-[.72rem]"
                  >
                    <option value="">no price</option>
                    {detail.prices.map((pr) => (
                      <option key={pr.messageId} value={pr.messageId}>{pr.value} DH</option>
                    ))}
                  </UiSelect>
                  <span className="text-center text-[.75rem] font-semibold text-fg">
                    {price !== null ? `${price} DH` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
