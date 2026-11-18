import { useState } from "react";
import { postApi } from "../../api/client";
import { useToast } from "../ui/Toast";
import { control, button, errorText } from "./ui";

export function PasswordSettings() {
  const { showToast } = useToast();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPw.length < 10) { setError("New password must be at least 10 characters"); return; }
    if (newPw !== confirmPw) { setError("New passwords don't match"); return; }
    if (newPw === currentPw) { setError("New password must be different from the current one"); return; }
    setSaving(true);
    try {
      await postApi("/api/auth/password", { currentPassword: currentPw, newPassword: newPw });
      showToast("Password changed. Other devices were signed out.", "success");
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  const fields = [
    ["Current password", currentPw, setCurrentPw, "current-password"],
    ["New password (min 10 characters)", newPw, setNewPw, "new-password"],
    ["Confirm new password", confirmPw, setConfirmPw, "new-password"],
  ] as const;

  return (
    <form className="flex max-w-[360px] flex-col gap-2" onSubmit={save}>
      {fields.map(([placeholder, value, setter, autoComplete]) => (
        <input key={placeholder} className={control} type="password" placeholder={placeholder} autoComplete={autoComplete}
          value={value} disabled={saving} onChange={(e) => setter(e.target.value)} />
      ))}
      {error && <div className={errorText}>{error}</div>}
      <button type="submit" className={button} disabled={saving || !currentPw || !newPw || !confirmPw}>
        {saving ? "Saving..." : "Change password"}
      </button>
    </form>
  );
}
