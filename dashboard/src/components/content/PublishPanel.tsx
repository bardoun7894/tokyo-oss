import { useEffect, useRef, useState } from "react";
import { deleteApi, postApi } from "../../api/client";
import { useToast } from "../ui/Toast";
import {
  PLATFORMS,
  PLATFORM_LABEL,
  fmtWhen,
  humanDuration,
  humanSize,
  type ItemDetail,
  type Platform,
  type PlatformsMeta,
} from "./types";

interface Props {
  detail: ItemDetail;
  meta: PlatformsMeta | null;
  reload: () => Promise<ItemDetail | null>;
  onChanged: () => void;
}

interface Preflight {
  selected: Platform[];
  skipped: Array<{ platform: Platform; reason: string }>;
  problems: string[];
}

function localInputValue(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function uploadFile(itemId: number, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/content/items/${itemId}/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${window.__TOKEN__ ?? ""}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Upload failed: ${xhr.status}`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {
        /* keep status message */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export default function PublishPanel({ detail, meta, reload, onChanged }: Props) {
  const { showToast } = useToast();
  const { item, publications } = detail;
  const [selected, setSelected] = useState<Platform[]>(item.platforms);
  const [privacy, setPrivacy] = useState<"public" | "private">("public");
  const [check, setCheck] = useState<Preflight | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [when, setWhen] = useState(localInputValue(Date.now() + 3600_000));
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const active = detail.publishing || publications.some((p) => p.job_status === "running" || p.target_status === "running");

  // Poll while anything is in flight.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      reload().then((d) => {
        if (d && !d.publishing) onChanged();
      });
    }, 4000);
    return () => clearInterval(t);
  }, [active, reload, onChanged]);

  // Ask the server which selected platforms would really go out.
  useEffect(() => {
    setConfirmPublish(false);
    postApi<Preflight>(`/api/content/items/${item.id}/preflight`, { platforms: selected })
      .then(setCheck)
      .catch(() => setCheck(null));
  }, [item.id, item.video_path, selected]);

  function toggle(p: Platform) {
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || s.includes(x))));
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    setProgress(0);
    uploadFile(item.id, file, setProgress)
      .then(() => reload())
      .then(() => {
        showToast("Video uploaded", "success");
        onChanged();
      })
      .catch((err: Error) => showToast(err.message, "error"))
      .finally(() => {
        setProgress(null);
        if (fileRef.current) fileRef.current.value = "";
      });
  }

  function removeVideo() {
    deleteApi(`/api/content/items/${item.id}/video`)
      .then(() => reload())
      .then(onChanged)
      .catch((err: Error) => showToast(err.message || "Could not remove", "error"));
  }

  function publish() {
    setBusy(true);
    postApi<{ ok: boolean; jobs: unknown[] }>(`/api/content/items/${item.id}/publish`, {
      platforms: selected,
      privacy,
      confirm: true,
    })
      .then((r) => {
        showToast(`Publishing to ${r.jobs.length} platform${r.jobs.length === 1 ? "" : "s"}`, "info");
        setConfirmPublish(false);
        return reload();
      })
      .then(onChanged)
      .catch((err: Error) => showToast(err.message || "Publish failed", "error"))
      .finally(() => setBusy(false));
  }

  function schedule() {
    const ms = new Date(when).getTime();
    setBusy(true);
    postApi<{ ok: boolean; jobs: unknown[] }>(`/api/content/items/${item.id}/schedule`, {
      platforms: selected,
      privacy,
      when: ms,
    })
      .then((r) => {
        showToast(`Scheduled ${r.jobs.length} platform${r.jobs.length === 1 ? "" : "s"} for ${fmtWhen(ms)}`, "success");
        return reload();
      })
      .then(onChanged)
      .catch((err: Error) => showToast(err.message || "Schedule failed", "error"))
      .finally(() => setBusy(false));
  }

  function unschedule() {
    postApi<{ ok: boolean; cancelled: number }>(`/api/content/items/${item.id}/unschedule`)
      .then((r) => {
        showToast(`Cancelled ${r.cancelled} scheduled job${r.cancelled === 1 ? "" : "s"}`, "success");
        return reload();
      })
      .then(onChanged)
      .catch((err: Error) => showToast(err.message || "Cancel failed", "error"));
  }

  const statusOf = (p: Platform) => meta?.platforms.find((x) => x.platform === p);
  const scheduled = publications.filter((p) => p.job_status === "scheduled");
  const canGo = Boolean(check && !check.problems.length && check.selected.length) && !active && !busy;

  return (
    <div className="cs-publish">
      <section className="cs-panel">
        <h4>Video file</h4>
        {item.video_path ? (
          <div className="cs-file">
            <div>
              <strong>{item.video_name}</strong>
              <span className="cs-muted">
                {[humanSize(item.video_size), humanDuration(item.duration_sec), item.width && item.height ? `${item.width}×${item.height}` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {!detail.videoExists && <span className="cs-error">File is missing on disk — upload it again.</span>}
              {item.format === "short" && item.width && item.height && item.width >= item.height && (
                <span className="cs-warn">Not vertical — Shorts/Reels placement may not pick it up.</span>
              )}
            </div>
            <div className="cs-file-actions">
              <button onClick={() => fileRef.current?.click()} disabled={progress !== null}>Replace</button>
              <button className="cs-danger-outline" onClick={removeVideo} disabled={progress !== null || active}>Remove</button>
            </div>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} disabled={progress !== null}>Upload video…</button>
        )}
        <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        {progress !== null && (
          <div className="cs-progress" aria-label="Upload progress">
            <div style={{ width: `${progress}%` }} />
            <span>{progress < 100 ? `${progress}%` : "Checking video…"}</span>
          </div>
        )}
      </section>

      <section className="cs-panel">
        <h4>Platforms</h4>
        <div className="cs-platforms">
          {PLATFORMS.map((p) => {
            const st = statusOf(p);
            const skip = check?.skipped.find((s) => s.platform === p);
            return (
              <label key={p} className={`cs-platform${st?.configured ? "" : " off"}`}>
                <input type="checkbox" checked={selected.includes(p)} onChange={() => toggle(p)} />
                <span className="cs-platform-name">{PLATFORM_LABEL[p]}</span>
                <span className={`cs-pill ${st?.configured ? "ok" : "no"}`}>
                  {st ? (st.configured ? "connected" : "not connected") : "…"}
                </span>
                {st?.accountLabel && <span className="cs-muted">{st.accountLabel}</span>}
                {selected.includes(p) && skip && <span className="cs-warn">{skip.reason}</span>}
                {!st?.configured && st?.missing && !selected.includes(p) && <span className="cs-muted">{st.missing}</span>}
              </label>
            );
          })}
        </div>
        <div className="cs-row">
          <div className="cs-seg small">
            {(["public", "private"] as const).map((v) => (
              <button key={v} className={privacy === v ? "active" : ""} onClick={() => setPrivacy(v)}>
                {v === "public" ? "Public" : "Private"}
              </button>
            ))}
          </div>
          {check?.problems.map((p) => (
            <span key={p} className="cs-warn">{p}</span>
          ))}
          {check && !check.problems.length && (
            <span className="cs-muted">
              Will post to {check.selected.length ? check.selected.map((p) => PLATFORM_LABEL[p]).join(", ") : "nothing"}
            </span>
          )}
        </div>
      </section>

      <section className="cs-panel">
        <h4>Publish</h4>
        <div className="cs-row">
          {confirmPublish ? (
            <>
              <button className="cs-danger" onClick={publish} disabled={!canGo}>
                Yes, post now to {check?.selected.length ?? 0}
              </button>
              <button onClick={() => setConfirmPublish(false)}>Cancel</button>
            </>
          ) : (
            <button className="cs-primary" onClick={() => setConfirmPublish(true)} disabled={!canGo}>
              {active ? "Publishing…" : "Publish now"}
            </button>
          )}
        </div>
        <div className="cs-row">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Schedule time" />
          <button onClick={schedule} disabled={!canGo || !when}>Schedule</button>
          {scheduled.length > 0 && (
            <button className="cs-danger-outline" onClick={unschedule}>
              Cancel schedule ({scheduled.length})
            </button>
          )}
        </div>
        <p className="cs-note">Each platform gets its own copy from the Captions tab. Scheduled posts fire from the server and report to Telegram.</p>
      </section>

      {publications.length > 0 && (
        <section className="cs-panel">
          <h4>History</h4>
          <table className="cs-table">
            <tbody>
              {publications.map((p) => {
                const status = p.job_status === "scheduled" || p.job_status === "cancelled" ? p.job_status : p.target_status || p.job_status || "unknown";
                return (
                  <tr key={p.id}>
                    <td>{PLATFORM_LABEL[p.platform]}</td>
                    <td><span className={`cs-pill st-${status}`}>{status}</span></td>
                    <td className="cs-muted">
                      {p.job_status === "scheduled" && p.scheduled_at ? fmtWhen(p.scheduled_at) : p.finished_at || p.created_at}
                    </td>
                    <td>
                      {p.url && <a href={p.url} target="_blank" rel="noreferrer">Open</a>}
                      {p.error && <span className="cs-error" title={p.error}>{p.error.slice(0, 80)}</span>}
                      {p.warning && <span className="cs-warn" title={p.warning}>{p.warning.slice(0, 80)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
