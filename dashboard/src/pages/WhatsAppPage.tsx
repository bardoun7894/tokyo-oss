import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import type { WhatsAppStatus, WhatsAppChat, WhatsAppMessage } from "../types";
import { Button, Input, StatusDot } from "@bardouni/ui";

type ViewState =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "blocked" }
  | { kind: "pairing"; code: string }
  | { kind: "qr"; dataUrl: string }
  | { kind: "chatList"; chats: WhatsAppChat[] }
  | { kind: "openChat"; jid: string; name: string; messages: WhatsAppMessage[] };

export default function WhatsAppPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [phone, setPhone] = useState("");
  const [msgInput, setMsgInput] = useState("");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadChats = useCallback(() => {
    api<WhatsAppChat[]>("/api/whatsapp/chats")
      .then((chats) => setView({ kind: "chatList", chats: chats || [] }))
      .catch(() => setView({ kind: "chatList", chats: [] }));
  }, []);

  const loadStatus = useCallback(() => {
    clearPoll();
    api<WhatsAppStatus>("/api/whatsapp/status")
      .then((st) => {
        if (st.status === "connected") {
          loadChats();
        } else if (st.status === "pairing" && st.pairingCode) {
          setView({ kind: "pairing", code: st.pairingCode });
          pollRef.current = setTimeout(loadStatus, 3000);
        } else if (st.status === "qr" && st.qrDataUrl) {
          setView({ kind: "qr", dataUrl: st.qrDataUrl });
          pollRef.current = setTimeout(loadStatus, 3000);
        } else if (st.status === "connecting") {
          setView({ kind: "connecting" });
          pollRef.current = setTimeout(loadStatus, 2000);
        } else if (st.status === "blocked") {
          setView({ kind: "blocked" });
        } else {
          setView({ kind: "disconnected" });
        }
      })
      .catch(() => setView({ kind: "disconnected" }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPoll, loadChats]);

  useEffect(() => {
    loadStatus();
    return () => clearPoll();
  }, [loadStatus, clearPoll]);

  useEffect(() => {
    if (view.kind === "openChat") {
      const list = messagesEndRef.current?.parentElement;
      if (list) list.scrollTop = list.scrollHeight;
    }
  }, [view]);

  function handleConnect() {
    const cleaned = phone.trim().replace(/[^0-9]/g, "");
    setView({ kind: "connecting" });
    postApi("/api/whatsapp/connect", cleaned ? { phoneNumber: cleaned } : {})
      .then(() => {
        pollRef.current = setTimeout(loadStatus, 3000);
      })
      .catch(() => {
        showToast("Failed to connect", "error");
        setView({ kind: "disconnected" });
      });
  }

  function openChat(jid: string, name: string) {
    api<WhatsAppMessage[]>(`/api/whatsapp/messages/${encodeURIComponent(jid)}`)
      .then((msgs) => setView({ kind: "openChat", jid, name, messages: msgs || [] }))
      .catch(() => showToast("Failed to load messages", "error"));
  }

  function sendMessage(jid: string) {
    const text = msgInput.trim();
    if (!text) return;
    postApi<{ ok?: boolean; error?: string }>("/api/whatsapp/send", { jid, text })
      .then((r) => {
        if (r.ok) {
          setMsgInput("");
          setTimeout(() => openChat(jid, view.kind === "openChat" ? view.name : ""), 500);
        } else {
          showToast(r.error || "Failed to send", "error");
        }
      })
      .catch((err: Error) => showToast(err.message || "Failed to send", "error"));
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>WhatsApp</h2>

      <div className="max-h-[70vh] overflow-auto">
        {view.kind === "loading" && (
          <div className="loading">Loading WhatsApp...</div>
        )}

        {view.kind === "disconnected" && (
          <>
            <div className="wa-status">
              <StatusDot state="failed" title="Disconnected" />
              Disconnected
            </div>
            <div className="mt-2.5">
              <div className="mb-1.5 text-xs text-fg2">
                Enter your phone number (with country code):
              </div>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="text"
                  placeholder="966XXXXXXXXX"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                  className="min-w-[180px] flex-1 font-mono"
                />
                <Button variant="primary" onClick={handleConnect}>
                  Connect
                </Button>
              </div>
            </div>
          </>
        )}

        {view.kind === "connecting" && (
          <div className="wa-status">
            <StatusDot state="running" title="Connecting" />
            Connecting...
          </div>
        )}

        {view.kind === "blocked" && (
          <>
            <div className="wa-status">
              <StatusDot state="failed" title="Blocked" />
              VPS IP blocked by WhatsApp
            </div>
            <div className="my-2 text-[.82rem] leading-relaxed text-fg2">
              WhatsApp blocks all connections from datacenter IPs. Use a SOCKS5 proxy or pair from a local machine.
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                type="text"
                placeholder="966XXXXXXXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                className="min-w-[180px] flex-1 font-mono"
              />
              <Button variant="primary" onClick={handleConnect}>
                Connect
              </Button>
            </div>
          </>
        )}

        {view.kind === "pairing" && (
          <>
            <div className="wa-status">
              <StatusDot state="warn" title="Pairing code ready" />
              Pairing code ready
            </div>
            <div className="my-5 text-center">
              <div className="font-mono text-[2.5rem] font-semibold tracking-[.3em] text-green">
                {view.code}
              </div>
              <div className="mt-3 text-[.85rem] leading-relaxed text-fg2">
                On your phone: WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device &gt; Link with phone number
              </div>
            </div>
          </>
        )}

        {view.kind === "qr" && (
          <>
            <div className="wa-status">
              <StatusDot state="warn" title="Scan QR code" />
              Scan QR code with WhatsApp
            </div>
            <div className="p-5 text-center">
              <img src={view.dataUrl} alt="QR Code" className="mx-auto max-w-[300px] rounded-lg bg-white p-2" />
            </div>
          </>
        )}

        {view.kind === "chatList" && (
          <>
            <div className="wa-status mb-3">
              <StatusDot state="ok" title="Connected" />
              Connected ({view.chats.length} chats)
            </div>
            {view.chats.length === 0 ? (
              <div className="p-3 text-fg3">No chats yet</div>
            ) : (
              <div>
                {view.chats.map((c) => {
                  const time = c.lastTimestamp
                    ? new Date(c.lastTimestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
                    : "";
                  return (
                    <div
                      key={c.jid}
                      onClick={() => openChat(c.jid, c.name)}
                      className="flex cursor-pointer items-center gap-3 border-b border-line px-3.5 py-3 transition-colors hover:bg-surface2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[.88rem] font-semibold">{c.name}</div>
                        <div className="truncate text-[.8rem] text-fg2">
                          {c.lastMessage}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[.72rem] text-fg3">{time}</div>
                        {c.unreadCount > 0 && (
                          <div className="mt-0.5 inline-block rounded-[10px] bg-green px-2 py-0.5 text-[.72rem] font-semibold text-on-color">
                            {c.unreadCount}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {view.kind === "openChat" && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadChats}
              className="mb-2 !px-0 text-accent"
            >
              {"←"} Back to chats
            </Button>
            <div className="mb-3 text-base font-semibold">{view.name}</div>
            <div className="wa-messages max-h-[50vh] overflow-y-auto py-2">
              {view.messages.map((m) => {
                const cls = m.fromMe ? "me" : "them";
                const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
                return (
                  <div key={m.id} className={`wa-msg ${cls}`}>
                    {!m.fromMe && m.senderName && (
                      <div className="mb-0.5 text-[.72rem] font-semibold text-accent2">{m.senderName}</div>
                    )}
                    {m.content}
                    <span className="mt-0.5 block text-[.62rem] opacity-50">{time}</span>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
              <Input
                type="text"
                placeholder="Type a message..."
                value={msgInput}
                onChange={(e) => setMsgInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendMessage(view.jid); }}
                className="min-w-[180px] flex-1"
              />
              <Button variant="primary" onClick={() => sendMessage(view.jid)}>
                Send
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
