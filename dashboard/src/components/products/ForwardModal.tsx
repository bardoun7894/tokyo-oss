import { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, Switch, Textarea } from "@bardouni/ui";
import { confirmForward, fetchForwardTargets, previewForward } from "../../api/products";
import type { ForwardPreview, ForwardTarget } from "../../lib/products";
import { useToast } from "../ui/Toast";

interface ForwardModalProps {
  ids: number[];
  /** Set when the selection was larger than the cap and got truncated. */
  truncatedFrom?: number;
  onClose: () => void;
  onSent: () => void;
}

/**
 * The last gate before a real WhatsApp send. Nothing here calls
 * confirm:true until the user has read the exact captions that will go out
 * -- the 400-with-preview response from the backend is the intended path,
 * not an error to swallow.
 */
export default function ForwardModal({ ids, truncatedFrom, onClose, onSent }: ForwardModalProps) {
  const { showToast } = useToast();
  const [targets, setTargets] = useState<ForwardTarget[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [search, setSearch] = useState("");
  const [jid, setJid] = useState("");
  const [withPrice, setWithPrice] = useState(true);
  const [markup, setMarkup] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<ForwardPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchForwardTargets()
      .then((r) => setTargets(r.targets || []))
      .catch((err: Error) => showToast(err.message || "Failed to load contacts", "error"))
      .finally(() => setLoadingTargets(false));
  }, [showToast]);

  // Any change to the send parameters invalidates a stale preview -- confirm
  // must never fire on captions the user hasn't actually seen.
  useEffect(() => { setPreview(null); }, [jid, withPrice, markup, note]);

  const filteredTargets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => t.name.toLowerCase().includes(q));
  }, [targets, search]);

  const markupNum = markup.trim() === "" ? undefined : Number(markup);

  function body() {
    return {
      ids,
      jid,
      withPrice,
      markup: markupNum && markupNum > 0 ? markupNum : undefined,
      note: note.trim() || undefined,
    };
  }

  async function doPreview() {
    if (!jid) {
      showToast("Pick a contact or group first", "error");
      return;
    }
    setPreviewing(true);
    try {
      const p = await previewForward(body());
      setPreview(p);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Preview failed", "error");
    } finally {
      setPreviewing(false);
    }
  }

  async function doConfirm() {
    if (!preview) return;
    setSending(true);
    try {
      const res = await confirmForward({ ...body(), confirm: true } as Parameters<typeof confirmForward>[0]);
      if (res.failed > 0) {
        showToast(`Sent ${res.sent}, ${res.failed} failed`, "error");
      } else {
        showToast(`Sent ${res.sent} message${res.sent === 1 ? "" : "s"}`, "success");
      }
      onSent();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Send failed", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      title={`Forward ${ids.length} product${ids.length === 1 ? "" : "s"}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={sending}>Cancel</Button>
          {!preview ? (
            <Button variant="primary" onClick={() => void doPreview()} disabled={previewing || !jid || sending}>
              {previewing ? "Loading preview…" : "Preview"}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void doConfirm()} disabled={sending}>
              {sending ? "Sending…" : `Confirm & send to ${preview.target}`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {truncatedFrom && (
          <div className="rounded-md border border-amber bg-[color-mix(in_srgb,var(--amber)_10%,transparent)] p-2 text-[.78rem] text-amber">
            Only the first {ids.length} of {truncatedFrom} selected products will be sent. Narrow your filters to
            select the rest.
          </div>
        )}

        <Field label="Send to">
          <Input
            placeholder="Search contacts and groups…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-2"
          />
          <div className="max-h-[160px] overflow-y-auto rounded-md border border-line">
            {loadingTargets && <div className="p-3 text-[.78rem] text-fg3">Loading…</div>}
            {!loadingTargets && filteredTargets.length === 0 && (
              <div className="p-3 text-[.78rem] text-fg3">No matches.</div>
            )}
            {filteredTargets.map((t) => (
              <button
                key={t.jid}
                type="button"
                onClick={() => setJid(t.jid)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[.82rem] ${
                  jid === t.jid ? "bg-surface2 text-fg" : "text-fg2 hover:bg-surface1"
                }`}
              >
                <span dir="auto">{t.name}{t.isGroup ? " (group)" : ""}</span>
                {jid === t.jid && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[.82rem] text-fg2">
            <Switch checked={withPrice} onChange={setWithPrice} label="Include price" />
            Include price
          </label>
          <label className="flex items-center gap-2 text-[.82rem] text-fg2">
            Markup %
            <Input
              type="number"
              min={0}
              step={1}
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
              placeholder="0"
              className="w-20"
            />
          </label>
        </div>

        <Field label="Note (optional, appended to every caption)">
          <Textarea dir="auto" value={note} onChange={(e) => setNote(e.target.value)} placeholder="dispo hhad l'semana" />
        </Field>

        {preview && (
          <div className="rounded-lg border border-line bg-surface2 p-3">
            <div className="mb-2 text-[.8rem] font-medium text-fg">
              Exact captions that will be sent to {preview.target} ({preview.count})
            </div>
            <div className="flex max-h-[220px] flex-col gap-2 overflow-y-auto">
              {preview.captions.map((c, i) => (
                <pre key={i} dir="auto" className="m-0 rounded border border-line bg-bg1 p-2 text-[.75rem] whitespace-pre-wrap text-fg2">
                  {c}
                </pre>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
