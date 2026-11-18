import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ServerResponse } from "../types";
import { Button, ErrorState, Empty } from "@bardouni/ui";

export default function ServerPage() {
  const navigate = useNavigate();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string>("");

  function loadServer() {
    setLoading(true);
    setError(null);
    api<ServerResponse>("/api/server")
      .then((data) => {
        setContent(data.status || "");
        setLoading(false);
        setLastRefresh(new Date().toLocaleTimeString());
      })
      .catch(() => {
        setError("Failed to load server status");
        setLoading(false);
      });
  }

  useEffect(() => {
    loadServer();
  }, []);

  // Format content: split on double newlines, bold *text*
  const formattedLines = content
    .split("\n\n")
    .map((line) => line.replace(/\*([^*]+)\*/g, "<strong>$1</strong>"));

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Server Status</h2>

      <div className="mb-4 flex items-center gap-3">
        <Button variant="primary" onClick={loadServer} disabled={loading}>
          Refresh
        </Button>
        {lastRefresh && (
          <span className="text-xs text-fg3">
            Last refreshed: {lastRefresh}
          </span>
        )}
      </div>

      {loading && (
        <div className="loading">Loading server status...</div>
      )}

      {error && <ErrorState msg={error} />}

      {!loading && !error && content && (
        <div
          className="whitespace-pre-line rounded-lg bg-surface1 p-5 font-mono text-[.85rem] leading-relaxed text-fg2"
          dangerouslySetInnerHTML={{ __html: formattedLines.join("<br>") }}
        />
      )}

      {!loading && !error && !content && <Empty>No server status data available</Empty>}
    </div>
  );
}
