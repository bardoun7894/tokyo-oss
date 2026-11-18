import { useState, useRef, useEffect } from "react";
import { api } from "../../api/client";
import type { ConversationMessage } from "../../types";

export function ChatCard() {
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loaded && wrapRef.current) {
      wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
    }
  }, [loaded, messages]);

  function loadChat() {
    setLoading(true);
    setError(null);
    api<ConversationMessage[]>("/api/conversations?limit=50")
      .then((msgs) => {
        if (!msgs || msgs.length === 0) {
          setMessages([]);
        } else {
          // Reverse to chronological order
          setMessages(msgs.slice().reverse());
        }
        setLoaded(true);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load");
        setLoading(false);
      });
  }

  if (!loaded && !loading && !error) {
    return (
      <button className="load-btn" onClick={loadChat}>
        Load Chat Messages
      </button>
    );
  }

  if (loading) {
    return <div className="loading">Loading messages...</div>;
  }

  if (error) {
    return <div className="loading">{error}</div>;
  }

  if (messages.length === 0) {
    return <div className="loading">No messages yet</div>;
  }

  return (
    <div className="chat-wrap" ref={wrapRef} style={{ maxHeight: 500, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
      {messages.map((m) => {
        const cls = m.role === "user" ? "user" : "assistant";
        const text =
          m.content.length > 800
            ? m.content.slice(0, 800) + "..."
            : m.content;

        return (
          <div key={m.id} className={`chat-msg ${cls}`}>
            {text}
          </div>
        );
      })}
    </div>
  );
}
