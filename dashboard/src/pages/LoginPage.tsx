import { useState } from "react";

const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

const input =
  "mb-4 w-full rounded-lg border border-line bg-surface2 px-3.5 py-2.5 text-[.9rem] text-fg outline-none focus:border-accent";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.token) {
        document.cookie = `tokyo_session=${data.token};path=/;max-age=${SESSION_MAX_AGE};SameSite=Strict`;
        // Full load, not a client-side navigate: the server injects the session
        // token into the page, and the API client reads it from there.
        window.location.href = "/";
        return;
      }
      setError(data.error ?? "Invalid username or password");
    } catch {
      setError("Cannot reach the dashboard server");
    }
    setBusy(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-[360px] max-w-[90vw] rounded-lg border border-line bg-surface p-10">
        <h1 className="mb-2 text-center text-2xl font-semibold text-accent">Tokyo</h1>
        <p className="mb-6 text-center text-[.85rem] text-fg2">Sign in to your dashboard</p>
        {error && <div className="mb-3 text-center text-[.82rem] text-red">{error}</div>}
        <label htmlFor="login-username" className="mb-1 block text-[.8rem] text-fg2">Username</label>
        <input id="login-username" type="text" autoComplete="username" required autoFocus className={input}
          value={username} onChange={e => setUsername(e.target.value)} />
        <label htmlFor="login-password" className="mb-1 block text-[.8rem] text-fg2">Password</label>
        <input id="login-password" type="password" autoComplete="current-password" required className={input}
          value={password} onChange={e => setPassword(e.target.value)} />
        <button type="submit" disabled={busy}
          className="w-full cursor-pointer rounded-lg border-none bg-accent p-3 text-[.9rem] font-semibold text-on-color transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-60">
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
