import { readFileSync } from "fs";
import type { OutboxRow, PushStore } from "./store";
import type { NtfyMessage } from "./format";
import { encryptWebPush } from "./webpush";

/** Tokyo talks to its own ntfy over loopback; the public site is only for phones. */
export const NTFY_LOCAL = "http://127.0.0.1:2586";
export const NTFY_CONFIG_PATH = "/etc/tokyo/ntfy.json";

export interface NtfyConfig { baseUrl: string; publishToken: string; format: "up" | "ntfy" }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string | Uint8Array; signal: AbortSignal }) => Promise<{ status: number }>;
type Req = { url: string; headers: Record<string, string>; body: string | Uint8Array };

/**
 * `/etc/tokyo/ntfy.json` (`{baseUrl, publishToken, format?}`), re-read at most every `ttlMs`. A missing, unreadable or invalid
 * file means push is off: the getter answers null and says so once. File contents never reach the log.
 */
export function ntfyConfig(o: {
  read?: (path: string) => string; path?: string; log?: (m: string) => void; now?: () => number; ttlMs?: number;
} = {}): () => NtfyConfig | null {
  const read = o.read ?? ((p: string) => readFileSync(p, "utf8"));
  const path = o.path ?? NTFY_CONFIG_PATH;
  const log = o.log ?? ((m: string) => console.warn(m));
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 30_000;
  let cached: NtfyConfig | null = null;
  let at = -Infinity;
  let said = false;
  const off = (why: string): null => {
    if (!said) { said = true; log(`[push] off: ${why}`); }
    return null;
  };
  return () => {
    const t = now();
    if (t - at < ttl) return cached;
    at = t;
    let raw: string;
    try {
      raw = read(path);
    } catch (e: any) {
      cached = off(e?.code === "ENOENT" ? "no ntfy config file" : "ntfy config unreadable");
      return cached;
    }
    let j: any;
    try { j = JSON.parse(raw); } catch { cached = off("ntfy config is not JSON"); return cached; }
    const format = j?.format === undefined ? "up" : j.format;
    if (typeof j?.baseUrl !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/*$/.test(j.baseUrl) || typeof j.publishToken !== "string" || !j.publishToken || (format !== "up" && format !== "ntfy")) {
      cached = off("ntfy config is invalid");
      return cached;
    }
    said = false;
    cached = { baseUrl: j.baseUrl.replace(/\/+$/, ""), publishToken: j.publishToken, format };
    return cached;
  };
}

export type SendResult = "sent" | "failed" | "off";

/** Sends outbox rows to the local ntfy: 5 s timeout, one retry for network errors and 5xx, never a retry for 4xx. */
export class Publisher {
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly o: {
    store: PushStore; config: () => NtfyConfig | null; fetch?: FetchLike; now?: () => number; log?: (m: string) => void;
    timeoutMs?: number; retryDelayMs?: number;
  }) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.warn(m));
    this.timeoutMs = o.timeoutMs ?? 5000;
    this.retryDelayMs = o.retryDelayMs ?? 1000;
  }

  get enabled(): boolean { return this.o.config() !== null; }

  async send(row: OutboxRow): Promise<SendResult> {
    const cfg = this.o.config();
    if (!cfg) return "off";
    const ep = this.o.store.get(row.deviceId);
    if (!ep) { this.o.store.markFailed(row.id, 0, this.now()); return "failed"; }
    const req = this.request(cfg, ep.topic, row, ep);
    if (!req) { this.o.store.markFailed(row.id, 0, this.now()); this.log(`[push] ${row.type}: unusable payload`); return "failed"; }
    if (req === "unencryptable") {
      // The device stored keys that cannot encrypt: never fall back to plaintext. The row fails as rejected until the app registers again.
      this.o.store.markFailed(row.id, 0, this.now());
      this.o.store.recordFailure(row.deviceId, "rejected", this.now());
      this.log(`[push] ${row.type}: could not encrypt for the device's keys`);
      return "failed";
    }

    let attempts = 0;
    let kind: "unreachable" | "rejected" = "unreachable";
    for (; attempts < 2;) {
      attempts += 1;
      const status = await this.post(req);
      if (status !== null && status >= 200 && status < 300) {
        this.o.store.markSent(row.id, this.now(), attempts);
        this.o.store.recordSent(row.deviceId, this.now());
        return "sent";
      }
      if (status !== null && status >= 400 && status < 500 && status !== 429) { kind = "rejected"; break; }
      kind = "unreachable";
      if (attempts < 2 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
    }
    this.o.store.markFailed(row.id, attempts, this.now());
    this.o.store.recordFailure(row.deviceId, kind, this.now());
    this.log(`[push] ${row.type} not delivered (${kind})`);
    return "failed";
  }

  /**
   * The request for one row. In the UnifiedPush format a device that stored both `p256dh` and `auth` gets the RFC 8291 encrypted record
   * (`Content-Encoding: aes128gcm`; the payload was built and checked by format.ts before it was queued); one without keys gets the JSON
   * as before. The ntfy-native format shows text on the phone, is never encrypted, and is published as ntfy JSON (Arabic titles do not fit a header).
   */
  private request(cfg: NtfyConfig, topic: string, row: OutboxRow, keys?: { p256dh: string | null; auth: string | null }): Req | "unencryptable" | null {
    const auth = { Authorization: `Bearer ${cfg.publishToken}` };
    if (cfg.format === "up") {
      if (keys?.p256dh && keys.auth) {
        try {
          return { url: `${NTFY_LOCAL}/${topic}?up=1`, headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm" }, body: encryptWebPush(Buffer.from(row.payload, "utf8"), { p256dh: keys.p256dh, auth: keys.auth }) };
        } catch {
          return "unencryptable";
        }
      }
      return { url: `${NTFY_LOCAL}/${topic}?up=1`, headers: { ...auth, "Content-Type": "application/json" }, body: row.payload };
    }
    let m: NtfyMessage;
    try { m = JSON.parse(row.payload); } catch { return null; }
    if (typeof m?.title !== "string" || typeof m.message !== "string" || !Array.isArray(m.tags) || typeof m.click !== "string") return null;
    // ntfy JSON publishing (POST to the server root with the topic in the body): headers must be Latin-1, so an Arabic title only fits in JSON.
    return { url: `${NTFY_LOCAL}/`, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ topic, title: m.title, message: m.message, tags: m.tags, click: m.click }) };
  }

  /** The HTTP status, or null for a network error or a timeout. The error itself is dropped: it may echo a header. */
  private async post(req: Req): Promise<number | null> {
    const ctl = new AbortController();
    const f = this.o.fetch ?? ((url, init) => fetch(url, init));
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_res, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error("timeout")); }, this.timeoutMs); });
      const res = await Promise.race([f(req.url, { method: "POST", headers: req.headers, body: req.body, signal: ctl.signal }), timeout]);
      return res.status;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
