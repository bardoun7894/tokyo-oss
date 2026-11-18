import { useEffect, useState } from "react";
import { api, postApi } from "../../api/client";
import { useToast } from "../ui/Toast";
import { field, labelCol, labelText, hint, control, button } from "./ui";

interface ModelSetting {
  model: "claude" | "kieai";
  label: string;
  hasKieKey: boolean;
}

// Chat model and KIE.ai key.
export function AiModelSettings() {
  const { showToast } = useToast();
  const [modelSettings, setModelSettings] = useState<ModelSetting | null>(null);
  const [kieKey, setKieKey] = useState("");
  const [loading, setLoading] = useState(false);

  function load() {
    api<ModelSetting>("/api/settings/model")
      .then(setModelSettings)
      .catch((err: Error) => showToast(err.message || "Failed to load settings", "error"));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  async function changeModel(model: string) {
    if (model === "kieai" && !modelSettings?.hasKieKey) {
      showToast("Please enter a KIE API Key first", "error");
      return;
    }
    setLoading(true);
    try {
      const res = await postApi<{ model: ModelSetting["model"]; label: string }>("/api/settings/model", { model });
      setModelSettings((prev) => (prev ? { ...prev, model: res.model, label: res.label } : null));
      showToast(`Switched to ${res.label}`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to switch model", "error");
    } finally {
      setLoading(false);
    }
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!kieKey.trim()) return;
    setLoading(true);
    try {
      await postApi("/api/settings/kie-key", { key: kieKey.trim() });
      showToast("KIE.ai API Key saved", "success");
      setKieKey("");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save key", "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className={`${field} border-t`}>
        <div className={labelCol}>
          <span className={labelText}>Chat model</span>
          {modelSettings && !modelSettings.hasKieKey && <small className={hint}>GPT-5.4 needs a KIE API key</small>}
        </div>
        <select className={control} value={modelSettings?.model ?? ""} disabled={loading || !modelSettings}
          onChange={(e) => changeModel(e.target.value)}>
          <option value="claude">Claude (Anthropic)</option>
          <option value="kieai" disabled={!modelSettings?.hasKieKey}>GPT-5.4 (kie.ai)</option>
        </select>
      </div>
      <form className={field} onSubmit={saveKey}>
        <div className={labelCol}>
          <span className={labelText}>KIE.ai API key</span>
          <small className={hint}>{modelSettings?.hasKieKey ? "A key is saved. Enter a new one to replace it." : "No key saved."}</small>
        </div>
        <div className="flex gap-1.5">
          <input className={`${control} w-full sm:w-[220px]`} type="password" placeholder="Bearer token" value={kieKey}
            disabled={loading} onChange={(e) => setKieKey(e.target.value)} />
          <button type="submit" className={button} disabled={loading || !kieKey.trim()}>Save</button>
        </div>
      </form>
    </>
  );
}
