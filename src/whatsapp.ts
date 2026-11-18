import makeWASocket, {
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import * as QRCode from "qrcode";
import path from "path";
import fs from "fs";
import * as db from "./db";
import { mediaDir } from "./media-dir";
import { processIncomingMessage } from "./whatsapp-ai";
import { handleTranscribedAudio } from "./notify";
import * as shopGroup from "./shop-group";
import { shouldAutoTranscribe } from "./auto-transcribe";
import { matchProject } from "./project-registry";
import { isTemporalEnabled, getTemporalClient, TEMPORAL_TASK_QUEUE } from "./temporal/client";
import { startTemporalWorkerIfEnabled } from "./temporal/worker";
import { waChatWorkflow, inbound as waInboundSignal } from "./temporal/workflows";

const AUTH_DIR = path.join(__dirname, "..", "whatsapp-auth");
const MAX_MESSAGES_PER_CHAT = 100;
// Backfilled media older than this is stored as a row but never downloaded/transcribed.
const HISTORY_MEDIA_MAX_AGE_S = 14 * 24 * 60 * 60;
let reconnectAttempt = 0;

// --- failure alerting -------------------------------------------------------
// This bridge failed silently for two days: the socket logged out, the handler
// printed one line and returned, and pm2 kept reporting the process healthy
// while nothing at all was being captured. Anything that stops ingestion now
// has to reach a human.

let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function alertOwner(text: string, force = false): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!token || !chatId) {
    console.warn("⚠️  TELEGRAM_BOT_TOKEN/USER_ID unset — cannot alert:", text);
    return;
  }
  if (!force && Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = Date.now();
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("alertOwner failed:", err);
  }
}

/**
 * A logged-out session can never recover on its own — the stored credentials
 * are dead, and Baileys will not emit a QR while they are still on disk. Move
 * them aside so the next connect produces a fresh QR to scan, keeping the old
 * directory around in case the logout turns out to have been spurious.
 */
function archiveDeadCreds(): string | null {
  try {
    if (!fs.existsSync(AUTH_DIR)) return null;
    const dest = `${AUTH_DIR}.loggedout-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(AUTH_DIR, dest);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log(`📱 archived dead credentials -> ${path.basename(dest)}`);
    return dest;
  } catch (err) {
    console.error("could not archive credentials:", err);
    return null;
  }
}

/**
 * Ingestion watchdog. The socket can look "connected" while delivering
 * nothing, so health is measured by the only thing that matters: whether rows
 * are still landing in the database.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
let watchdogStarted = false;

function startIngestWatchdog(): void {
  setInterval(async () => {
    try {
      const lastTs = db.getLastWhatsAppMessageTs();
      const last = lastTs ? lastTs * 1000 : 0;
      if (!last) return;

      const ageMs = Date.now() - last;
      if (ageMs > STALE_AFTER_MS) {
        const hours = Math.round(ageMs / 3600000);
        await alertOwner(
          `⚠️ Tokyo WhatsApp: aucun message reçu depuis ${hours}h.\n` +
            `Statut socket: ${connectionStatus}.\n` +
            `Si "disconnected", relie l'appareil: pm2 restart tokyo && pm2 logs tokyo`,
        );
      }
    } catch (err) {
      console.error("ingest watchdog failed:", err);
    }
  }, 30 * 60 * 1000).unref();
}

interface ChatInfo {
  jid: string;
  name: string;
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
}

interface MessageInfo {
  id: string;
  jid: string;
  sender: string;
  senderName: string;
  content: string;
  fromMe: boolean;
  timestamp: number;
}

let sock: WASocket | null = null;
let connectionStatus: "disconnected" | "connecting" | "qr" | "pairing" | "connected" | "blocked" = "disconnected";
let qrDataUrl: string | null = null;
let pairingCode: string | null = null;
let userInfo: { id?: string; name?: string } | null = null;
const chats = new Map<string, ChatInfo>();
const messageStore = new Map<string, MessageInfo[]>();
let pendingPhoneNumber: string | null = null;

export async function startWhatsApp(phoneNumber?: string): Promise<void> {
  if (!watchdogStarted) {
    watchdogStarted = true;
    startIngestWatchdog();
    // Start the embedded Temporal worker at boot, not on the first new message:
    // wa-chat workflows left mid-debounce by a restart need a worker to resume.
    if (isTemporalEnabled()) {
      startTemporalWorkerIfEnabled().catch(err => console.error("Temporal worker start failed:", err));
    }
  }

  if (connectionStatus === "connecting" || connectionStatus === "qr" || connectionStatus === "pairing") return;

  if (phoneNumber) pendingPhoneNumber = phoneNumber;

  try {
    connectionStatus = "connecting";
    pairingCode = null;
    qrDataUrl = null;

    // Clear stale unregistered auth — old failed pairing creds cause 405 rejections on VPS
    try {
      const credsPath = path.join(AUTH_DIR, "creds.json");
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
        if (!creds.registered) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          console.log("📱 Cleared stale unregistered WhatsApp auth");
          // If no phone number provided and creds weren't registered, can't auto-connect
          if (!pendingPhoneNumber) {
            connectionStatus = "disconnected";
            console.log("📱 No registered session found. Connect from dashboard with phone number.");
            return;
          }
        }
      } else if (!pendingPhoneNumber) {
        // No auth exists and no phone number — nothing to do
        connectionStatus = "disconnected";
        console.log("📱 No WhatsApp session. Connect from dashboard with phone number.");
        return;
      }
    } catch (e) {
      console.error("📱 Failed to check/clear auth:", e);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let waVersion: [number, number, number] = [2, 3000, 1035194821];
    try {
      const { version } = await fetchLatestBaileysVersion();
      waVersion = version as [number, number, number];
      console.log("📱 WA version (latest):", waVersion.join("."));
    } catch (e) {
      console.log("📱 WA version fetch failed, using fallback", waVersion.join("."));
    }
    const proxyUrl = process.env.WA_PROXY;
    console.log(`📱 WA_PROXY env: ${proxyUrl || "(not set)"}`);
    const socketOpts: any = {
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 60_000,
      version: waVersion,
      browser: Browsers.macOS("Safari"),
      // Off by default: the initial sync already covers recent history, and a full
      // one replays years of messages. Set WA_SYNC_FULL_HISTORY=1 for the one
      // pairing where a long outage has to be recovered.
      syncFullHistory: process.env.WA_SYNC_FULL_HISTORY === "1",
    };
    if (proxyUrl) {
      const url = new URL(proxyUrl);
      const https = require("https");
      const tls = require("tls");
      const { SocksClient } = require("socks");
      const socksHost = url.hostname || "localhost";
      const socksPort = parseInt(url.port || "40000");

      class SocksAgent extends https.Agent {
        createConnection(opts: any, cb: any) {
          console.log(`📱 SOCKS connecting to ${opts.host}:${opts.port}`);
          SocksClient.createConnection({
            proxy: { host: socksHost, port: socksPort, type: 5 },
            command: "connect",
            destination: { host: opts.host, port: parseInt(opts.port) || 443 },
          }).then((info: any) => {
            const tlsSocket = tls.connect({ socket: info.socket, host: opts.host, servername: opts.host });
            cb(null, tlsSocket);
          }).catch((err: any) => {
            console.error(`📱 SOCKS error: ${err.message}`);
            cb(err);
          });
        }
      }
      socketOpts.agent = new SocksAgent();
      console.log(`📱 Using SOCKS5 proxy: ${socksHost}:${socksPort}`);
    }
    sock = makeWASocket(socketOpts);

    // If phone number provided, request pairing code (bypasses QR, works on VPS)
    if (pendingPhoneNumber && !state.creds.registered) {
      setTimeout(async () => {
        try {
          if (!sock) return;
          const code = await sock.requestPairingCode(pendingPhoneNumber!);
          pairingCode = code;
          connectionStatus = "pairing";
          console.log("📱 WhatsApp pairing code:", code);
          console.log("📱 Enter this code on your phone: WhatsApp > Linked Devices > Link a Device > Link with phone number");
        } catch (err) {
          console.error("📱 Failed to request pairing code:", err);
        }
      }, 5000);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const errCode = (lastDisconnect?.error as any)?.output?.statusCode;

      if (qr && !pendingPhoneNumber) {
        connectionStatus = "qr";
        qrDataUrl = await QRCode.toDataURL(qr);
        console.log("📱 WhatsApp QR code ready — scan from dashboard");
      }

      if (connection === "close") {
        qrDataUrl = null;

        if (errCode === 405) {
          // VPS IP blocked — stop retrying, user needs proxy or local pairing
          connectionStatus = "blocked";
          pairingCode = null;
          pendingPhoneNumber = null;
          console.log("📱 WhatsApp: VPS IP blocked (405). Set WA_PROXY in .env or pair from local machine.");
          // Also a permanent stop with no retry — it must not fail quietly.
          await alertOwner(
            "🔴 Tokyo WhatsApp: IP du VPS bloquée (405).\n" +
              "Aucun message n'est enregistré. Vérifie le proxy WA_PROXY (SOCKS) dans .env.",
            true,
          );
        } else if (errCode === DisconnectReason.loggedOut) {
          // Previously this branch just logged and returned, leaving the process
          // alive and permanently deaf with pm2 still reporting it healthy.
          // Now: bin the dead credentials, come back up so a QR is waiting, and
          // tell the owner — re-pairing needs a human with the phone.
          connectionStatus = "disconnected";
          pairingCode = null;
          pendingPhoneNumber = null;
          console.log("📱 WhatsApp logged out — archiving credentials and re-arming QR.");
          archiveDeadCreds();
          await alertOwner(
            "🔴 Tokyo WhatsApp déconnecté (session expirée).\n" +
              "Aucun message n'est enregistré tant que l'appareil n'est pas relié.\n" +
              "Ouvre le dashboard Tokyo pour scanner le QR, ou:\n" +
              "  pm2 restart tokyo && pm2 logs tokyo\n" +
              "WhatsApp → Appareils connectés → Connecter un appareil",
            true,
          );
          reconnectAttempt = 0;
          setTimeout(() => startWhatsApp(), 5000);
        } else {
          connectionStatus = "disconnected";
          pairingCode = null;
          reconnectAttempt++;
          const delay = Math.min(10000 * Math.pow(2, reconnectAttempt - 1), 300000); // 10s, 20s, 40s, ... max 5min
          console.log(`📱 WhatsApp disconnected (code ${errCode}), reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})...`);
          setTimeout(() => startWhatsApp(), delay);
        }
      } else if (connection === "open") {
        connectionStatus = "connected";
        qrDataUrl = null;
        pairingCode = null;
        pendingPhoneNumber = null;
        reconnectAttempt = 0; // reset on successful connection
        userInfo = sock?.user ? { id: sock.user.id, name: sock.user.name || undefined } : null;
        console.log("📱 WhatsApp connected as", userInfo?.name || userInfo?.id);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const msg of messages) {
        processMessage(msg, type);
      }
    });

    // Backfill after a re-pair. Baileys replays whatever the phone still holds
    // through messaging-history.set; without this handler those messages are
    // dropped and every disconnect leaves a permanent hole in life.db.
    // Deduped in saveWAMessage via the (jid, wa_msg_id) unique index.
    sock.ev.on("messaging-history.set", (ev: any) => {
      const { messages, isLatest, progress } = ev || {};
      if (!messages?.length) return;
      let stored = 0;
      for (const msg of messages) {
        if (processMessage(msg, "history")) stored++;
      }
      console.log(
        `📱 History sync: ${stored} new / ${messages.length} replayed` +
        (progress != null ? ` (${progress}%)` : "") +
        (isLatest ? " [final batch]" : ""),
      );
    });

    sock.ev.on("chats.upsert", (newChats) => {
      for (const chat of newChats) {
        const jid = (chat as any).id;
        if (!jid || jid === "status@broadcast") continue;
        if (!chats.has(jid)) {
          chats.set(jid, {
            jid,
            name: (chat as any).name || jid.split("@")[0],
            lastMessage: "",
            lastTimestamp: 0,
            unreadCount: (chat as any).unreadCount || 0,
          });
        }
      }
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        const jid = (contact as any).id;
        if (!jid) continue;
        const existing = chats.get(jid);
        if (existing && (contact as any).notify) {
          existing.name = (contact as any).notify;
        } else if (!existing && (contact as any).notify) {
          chats.set(jid, {
            jid,
            name: (contact as any).notify,
            lastMessage: "",
            lastTimestamp: 0,
            unreadCount: 0,
          });
        }
      }
    });
  } catch (err) {
    console.error("WhatsApp start error:", err);
    connectionStatus = "disconnected";
    reconnectAttempt++;
    const delay = Math.min(10000 * Math.pow(2, reconnectAttempt - 1), 300000);
    console.log(`📱 Retrying WhatsApp in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})...`);
    setTimeout(() => startWhatsApp(), delay);
  }
}

// Returns true when the message was newly written to the DB, false when it was
// skipped or already present. The history handler counts on that distinction.
// WA_TEMPORAL dispatch: durable per-chat queue via a Temporal workflow
// (wa-chat-<jid>). Fire-and-forget from the caller's perspective, same as
// the direct processIncomingMessage(...).catch() it replaces. On any
// failure to signal/start (worker down, server unreachable, bad namespace)
// it falls back to the exact same direct call so no message is ever lost.
async function dispatchViaTemporal(
  jid: string,
  dbId: number,
  timestamp: number,
  msg: Parameters<typeof processIncomingMessage>[0],
): Promise<void> {
  try {
    await startTemporalWorkerIfEnabled();
    const client = await getTemporalClient();
    await client.workflow.signalWithStart(waChatWorkflow, {
      workflowId: `wa-chat-${jid}`,
      taskQueue: TEMPORAL_TASK_QUEUE,
      signal: waInboundSignal,
      signalArgs: [{ msgId: dbId, ts: timestamp }],
      args: [jid],
    });
  } catch (err) {
    console.error("Temporal signalWithStart failed, falling back to direct dispatch:", err);
    processIncomingMessage(msg).catch(e => console.error("WA AI process error:", e));
  }
}

function processMessage(msg: WAMessage, type: string): boolean {
  const isHistory = type === "history";
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return false;

  const content = extractContent(msg);
  if (!content) return false;

  const isGroup = jid.endsWith("@g.us");
  const fromMe = msg.key.fromMe || false;
  const sender = msg.key.participant || jid;
  const senderName = (msg as any).pushName || jid.split("@")[0];
  const timestamp = typeof msg.messageTimestamp === "number"
    ? msg.messageTimestamp
    : Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

  // Detect message type
  const m = msg.message;
  let messageType = "text";
  if (m?.imageMessage) messageType = "image";
  else if (m?.videoMessage) messageType = "video";
  else if (m?.audioMessage) messageType = "audio";
  else if (m?.documentMessage) messageType = "document";
  else if (m?.stickerMessage) messageType = "sticker";
  else if (m?.contactMessage) messageType = "contact";
  else if (m?.locationMessage) messageType = "location";

  const info: MessageInfo = {
    id: msg.key.id || "",
    jid,
    sender,
    senderName,
    content,
    fromMe,
    timestamp,
  };

  // Store in memory
  if (!messageStore.has(jid)) messageStore.set(jid, []);
  const chatMsgs = messageStore.get(jid)!;
  chatMsgs.push(info);
  if (chatMsgs.length > MAX_MESSAGES_PER_CHAT) chatMsgs.shift();

  const existing = chats.get(jid);
  if (existing) {
    existing.lastMessage = content.slice(0, 100);
    existing.lastTimestamp = timestamp;
    if (!fromMe && type === "notify") existing.unreadCount++;
  } else {
    chats.set(jid, {
      jid,
      name: senderName,
      lastMessage: content.slice(0, 100),
      lastTimestamp: timestamp,
      unreadCount: fromMe ? 0 : 1,
    });
  }

  // Sync contact name if it changed in WhatsApp
  try { db.syncWAContactName(jid, senderName); } catch {}

  // Skip storing outgoing echoes that match a recent auto-reply — prevents the
  // feedback loop where Tokyo's own replies become style examples for the next draft.
  if (fromMe && content) {
    try {
      const { pendingAutoReplyFingerprints, autoReplyFingerprint } = require("./whatsapp-ai");
      if (pendingAutoReplyFingerprints.has(autoReplyFingerprint(jid, content))) {
        return false;
      }
    } catch {}
  }

  // Store in database + trigger AI analysis (async, non-blocking)
  try {
    const result = db.saveWAMessage({
      jid, sender, sender_name: senderName, content,
      message_type: messageType, from_me: fromMe, is_group: isGroup, timestamp,
      wa_msg_id: msg.key?.id ?? null,
      quoted_msg_id: extractQuotedMsgId(msg),
    });
    // Already stored — a history replay of a message we saw live. Re-running the
    // side effects below would re-post shop sales and re-trigger auto-replies.
    if ((result as any).changes === 0) return false;
    const dbId = (result as any).lastInsertRowid as number;

    // Shop group: handle text messages (async, non-blocking, swallowed)
    if (!isHistory && messageType !== "audio") {
      shopGroup.handleShopGroupMessage(
        { jid, sender, senderName, content, timestamp, fromMe, transcription: undefined, messageId: msg.key?.id ?? null },
        sock,
      ).catch(err => console.error("shop-group text error:", err));
    }

    // Download media (images, audio, video, documents) — async, non-blocking.
    // On backfill only the recent window is fetched: a re-pair can replay thousands
    // of old media messages and each one costs a transcription call.
    const withinBackfillMediaWindow =
      !isHistory || timestamp > Math.floor(Date.now() / 1000) - HISTORY_MEDIA_MAX_AGE_S;
    if (withinBackfillMediaWindow && ["image", "audio", "video", "document"].includes(messageType)) {
      downloadAndProcessMedia(msg, dbId, messageType, jid, senderName).catch(err =>
        console.error("WA media download error:", err)
      );
    }

    // Trigger AI analysis for incoming messages (non-blocking). Behind
    // WA_TEMPORAL: dispatch through the durable wa-chat workflow instead of
    // calling processIncomingMessage directly. Default OFF = old behaviour.
    // History replays never dispatch on either path.
    if (!isHistory && !fromMe && type === "notify") {
      const wmsg = {
        id: dbId, jid, sender, sender_name: senderName, content,
        message_type: messageType, from_me: false, is_group: isGroup, timestamp,
      };
      if (isTemporalEnabled()) {
        dispatchViaTemporal(jid, dbId, timestamp, wmsg).catch(err =>
          console.error("WA temporal dispatch error:", err));
      } else {
        processIncomingMessage(wmsg).catch(err => console.error("WA AI process error:", err));
      }
    }

    // Mission approvals typed in my own "message yourself" chat.
    if (!isHistory && fromMe && content && type === "notify") {
      require("./mission-wiring").handleMissionReply(jid, content, fromMe)
        .catch((err: any) => console.error("mission reply error:", err));
    }

    // Learn from the owner's manual replies
    if (!isHistory && fromMe && content) {
      try {
        const recentIncoming = db.getWAMessages(jid, 5) as any[];
        // Messages come back DESC, reverse to chronological order, find the last non-fromMe message
        const lastTheirMsg = recentIncoming.reverse().find((m: any) => !m.from_me && m.content);
        if (lastTheirMsg && (timestamp - lastTheirMsg.timestamp) < 300) {
          const contact = db.getWAContactCategory(jid);
          db.saveReplyPattern(
            jid,
            contact?.display_name || senderName,
            contact?.category || "other",
            lastTheirMsg.content,
            content,
          );
          console.log(`📱 Learned reply pattern: "${lastTheirMsg.content.slice(0, 40)}" → "${content.slice(0, 40)}"`);
        }
      } catch (err) {
        // Non-critical — don't break message processing
      }
    }
    return true;
  } catch (err) {
    console.error("WA DB save error:", err);
    return false;
  }
}

async function downloadAndProcessMedia(msg: WAMessage, dbId: number, messageType: string, jid: string, senderName: string): Promise<void> {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
    if (!buffer || buffer.length === 0) return;

    // Determine file extension
    const extMap: Record<string, string> = { image: "jpg", audio: "ogg", video: "mp4", document: "bin" };
    const m = msg.message;
    let ext = extMap[messageType] || "bin";
    if (m?.imageMessage?.mimetype?.includes("png")) ext = "png";
    if (m?.imageMessage?.mimetype?.includes("webp")) ext = "webp";
    if (m?.audioMessage?.mimetype?.includes("mp4")) ext = "m4a";
    if (m?.documentMessage?.fileName) {
      const docExt = m.documentMessage.fileName.split(".").pop();
      if (docExt) ext = docExt;
    }

    const filename = `wa_${dbId}_${Date.now()}.${ext}`;
    const filepath = path.join(mediaDir(), filename);
    fs.mkdirSync(mediaDir(), { recursive: true });
    fs.writeFileSync(filepath, buffer);

    const relativePath = `whatsapp-media/${filename}`;

    // Transcribe audio messages — delete audio file after transcription
    if (messageType === "audio" && msg.key?.fromMe !== true && require("./stt").isTranscriptionEnabled() && require("./stt").hasTranscriptionBackend()
        && autoTranscribeFor(jid, senderName)) {
      try {
        const transcribeResult = await transcribeAudio(buffer, ext);
        if (transcribeResult) {
          const transcription = transcribeResult.text;
          const durationSec = transcribeResult.durationSeconds;
          const wordCount = transcription.trim().split(/\s+/).filter(Boolean).length;
          const wpm = durationSec ? wordCount / (durationSec / 60) : null;
          db.updateWATranscriptionWithDuration(dbId, transcription, durationSec, wpm);
          // Delete audio file — we have the text now
          try { fs.unlinkSync(filepath); } catch {}
          console.log(`📱 WA transcribed audio from ${senderName}: "${transcription.slice(0, 60)}" wpm=${wpm?.toFixed(0) ?? "?"}`);
          // Shop group: ingest sale amount from transcription; skip saving to transcript file
          if (shopGroup.isShopGroup(jid)) {
            const audioSender = (msg.key.participant || jid);
            shopGroup.handleShopGroupMessage(
              { jid, sender: audioSender, senderName, content: "[Audio]", timestamp: Math.floor(Date.now() / 1000), fromMe: false, transcription },
              sock,
            ).catch(err => console.error("shop-group audio error:", err));
          } else {
            // Save transcript to per-project markdown + send owner TG DM (fire-and-forget)
            handleTranscribedAudio(jid, senderName, transcription).catch(err =>
              console.error("WA transcript side effects failed:", err)
            );
          }
          return;
        }
      } catch (err) {
        console.error("WA transcription failed:", err);
      }
    }

    // Describe images using Claude vision
    if (messageType === "image") {
      try {
        const description = await describeImage(buffer, ext);
        if (description) {
          db.updateWAMessageMedia(dbId, relativePath, description);
          console.log(`📱 WA described image from ${senderName}: "${description.slice(0, 60)}"`);
          return;
        }
      } catch (err) {
        console.error("WA image description failed:", err);
      }
    }

    // Save media path (no transcription)
    db.updateWAMessageMedia(dbId, relativePath);
    console.log(`📱 WA saved ${messageType} from ${senderName}: ${relativePath}`);
  } catch (err) {
    console.error(`WA media download failed for msg ${dbId}:`, err);
  }
}

// Work contacts only, unless the contact's dashboard setting says otherwise.
// A voice note skipped here keeps its audio and shows in Transcripts > Pending.
function autoTranscribeFor(jid: string, senderName: string): boolean {
  const contact = db.getWAContactCategory(jid);
  const yes = shouldAutoTranscribe({
    setting: contact?.auto_transcribe,
    category: contact?.category,
    matchesProject: !!matchProject(contact?.display_name || senderName),
    isShopGroup: shopGroup.isShopGroup(jid),
  });
  if (!yes) console.log(`📱 WA voice note from ${senderName} kept for manual transcription (not a work contact)`);
  return yes;
}

async function transcribeAudio(buffer: Buffer, ext: string): Promise<import("./stt").TranscribeResult | null> {
  const { transcribe } = await import("./stt");
  return transcribe(buffer, ext, "ar"); // Arabic for WhatsApp (Moroccan Darija)
}

async function describeImage(buffer: Buffer, ext: string): Promise<string | null> {
  const apiKey = process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({
    apiKey,
    baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
  });

  const mimeMap: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
  const mediaType = (mimeMap[ext] || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  const base64 = buffer.toString("base64");

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Describe this image briefly in 1-2 sentences. If it contains text, include the text. If it's a product photo, describe the product. If it's a screenshot, describe what's shown. If it's a document/receipt, extract key info. Be concise." },
      ],
    }],
  });

  const text = (response.content[0] as any)?.text?.trim();
  return text || null;
}

function extractContent(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return "[Image]" + (m.imageMessage.caption ? " " + m.imageMessage.caption : "");
  if (m.videoMessage) return "[Video]" + (m.videoMessage.caption ? " " + m.videoMessage.caption : "");
  if (m.audioMessage) return "[Audio]";
  if (m.documentMessage) return "[Document] " + (m.documentMessage.fileName || "");
  if (m.stickerMessage) return "[Sticker]";
  if (m.contactMessage) return "[Contact] " + (m.contactMessage.displayName || "");
  if (m.locationMessage) return "[Location]";
  if (m.reactionMessage) return null;
  return null;
}

/**
 * Resolve the id of the message a reply quotes (WhatsApp's
 * `contextInfo.stanzaId`), for pairing supplier price replies back to the
 * photo they quote (see src/products/pairing.ts). Baileys puts `contextInfo`
 * on whichever sub-message type the reply used — `extendedTextMessage` for a
 * text reply, `imageMessage` for an image reply, etc. — not at one fixed
 * path, so this walks every sub-message value generically instead of
 * hardcoding a shape. Exported for the ingest-extraction test.
 */
export function extractQuotedMsgId(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  for (const value of Object.values(m)) {
    const stanzaId = (value as any)?.contextInfo?.stanzaId;
    if (typeof stanzaId === "string" && stanzaId) return stanzaId;
  }
  return null;
}

// ---- Public API ----

/** My own JID (and LID when WhatsApp assigned one), for recognising my self-chat. */
export function getOwnJids(): { jid: string; lid?: string } | null {
  if (!sock?.user?.id) return null;
  return { jid: sock.user.id, lid: (sock.user as any).lid || undefined };
}

export function getWhatsAppStatus() {
  return { status: connectionStatus, qrDataUrl, pairingCode, user: userInfo };
}

export function getWhatsAppChats() {
  return Array.from(chats.values())
    .filter((c) => c.lastTimestamp > 0)
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, 50);
}

export function getWhatsAppMessages(jid: string, limit = 50) {
  return (messageStore.get(jid) || []).slice(-limit);
}

export async function sendWhatsAppMessage(jid: string, text: string) {
  if (!sock || connectionStatus !== "connected") throw new Error("WhatsApp not connected");
  
  // Validate JID format (must be number@s.whatsapp.net or group@g.us)
  if (!jid || !jid.includes("@")) {
    throw new Error(`Invalid JID format: "${jid}". You must provide the full WhatsApp JID (e.g. 212600000015@s.whatsapp.net). Use search_wa to find the target contact's JID first.`);
  }
  
  await sock.sendMessage(jid, { text });
}

export async function sendWhatsAppImage(jid: string, absPath: string, caption?: string) {
  if (!sock || connectionStatus !== "connected") throw new Error("WhatsApp not connected");

  // Validate JID format (must be number@s.whatsapp.net or group@g.us)
  if (!jid || !jid.includes("@")) {
    throw new Error(`Invalid JID format: "${jid}". You must provide the full WhatsApp JID (e.g. 212600000015@s.whatsapp.net). Use search_wa to find the target contact's JID first.`);
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(`Image file not found: "${absPath}"`);
  }

  await sock.sendMessage(jid, { image: { url: absPath }, caption });
}
