import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSettings, useSaveSetting, isOn, type SettingItem } from "../hooks/useSettings";
import { useToast } from "../components/ui/Toast";
import { AiModelSettings } from "../components/settings/AiModelSettings";
import { AutoTranscribeSettings } from "../components/settings/AutoTranscribeSettings";
import { PasswordSettings } from "../components/settings/PasswordSettings";
import { field, labelCol, labelText, hint, control, errorText } from "../components/settings/ui";
import { ThemeToggle } from "../components/layout/ThemeToggle";

const SECTIONS: { id: SettingItem["section"] | "security" | "appearance"; title: string; intro: string }[] = [
  { id: "appearance", title: "Appearance", intro: "Theme for this browser." },
  { id: "profile", title: "Profile", intro: "Who you are, where you live, your language, currency and work. Telegram /setup asks the same questions." },
  { id: "features", title: "Features", intro: "Turn whole parts of Tokyo on or off. Values saved here override .env." },
  { id: "modules", title: "Pages", intro: "Which pages show in the sidebar and on Home." },
  { id: "ai", title: "AI", intro: "Models and the automatic decisions Tokyo makes." },
  { id: "whatsapp", title: "WhatsApp & shop", intro: "Voice notes, the shop group, contacts." },
  { id: "jobhunt", title: "Job hunt", intro: "Limits for the automatic job applications." },
  { id: "security", title: "Security", intro: "Dashboard sign-in." },
];

const SOURCE_LABEL: Record<SettingItem["source"], string> = {
  dashboard: "set here",
  env: "from .env",
  default: "default",
};

function Switch({ on, disabled, onToggle }: { on: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onToggle}
      className={`relative h-[22px] w-10 shrink-0 cursor-pointer rounded-full border p-0 transition-colors ${
        on ? "border-accent bg-accent/20" : "border-line bg-surface2"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${on ? "left-5 bg-accent" : "left-0.5 bg-fg3"}`} />
    </button>
  );
}

function Field({ s, compact }: { s: SettingItem; compact?: boolean }) {
  const save = useSaveSetting();
  const { showToast } = useToast();
  // Reset when the saved value changes comes from the key={key + value} below.
  const [draft, setDraft] = useState(s.value);

  function commit(value: string | null) {
    if (value !== null && value === s.value && s.source === "dashboard") return;
    save.mutate({ key: s.key, value }, {
      onSuccess: () => showToast(value === null ? `${s.label}: reset` : `${s.label}: saved`, "success"),
      onError: (err) => { showToast(err.message, "error"); setDraft(s.value); },
    });
  }

  let input: React.ReactNode;
  if (s.type === "bool") {
    const on = isOn(s);
    input = <Switch on={on} disabled={save.isPending} onToggle={() => commit(on ? s.off! : s.on!)} />;
  } else if (s.type === "select") {
    input = (
      <select className={control} value={s.value} disabled={save.isPending} onChange={(e) => commit(e.target.value)}>
        {s.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else {
    input = (
      <input className={`${control} ${s.type === "number" ? "w-[110px]" : "w-full sm:w-[220px]"}`}
        type={s.type === "number" ? "number" : "text"} value={draft} min={s.min} max={s.max} step="any"
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== s.value) commit(draft); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    );
  }

  return (
    <div className={compact ? `${field} border-t first:border-t` : field}>
      <div className={labelCol}>
        <span className={labelText}>{s.label}</span>
        {s.help && !compact && <small className={hint}>{s.help}</small>}
        <small className={`flex items-center gap-2 text-[.74rem] ${s.source === "dashboard" ? "text-accent" : "text-fg3"}`}>
          {SOURCE_LABEL[s.source]}
          {s.source === "dashboard" && (
            <button type="button" onClick={() => commit(null)} disabled={save.isPending}
              className="cursor-pointer border-none bg-transparent p-0 text-[.72rem] text-fg2 underline">reset</button>
          )}
        </small>
      </div>
      {input}
    </div>
  );
}

export default function SettingsPage() {
  const { data, isLoading, error } = useSettings();
  const { hash } = useLocation();

  // /settings#whatsapp from a page's gear: jump to that section once it exists.
  useEffect(() => {
    if (!hash || !data) return;
    document.getElementById(`settings-${hash.slice(1)}`)?.scrollIntoView({ block: "start" });
  }, [hash, data]);

  return (
    <div className="max-w-[820px]">
      <h2 className="mb-4 text-xl font-semibold text-fg">Settings</h2>
      <nav className="sticky top-0 z-40 mb-3.5 flex flex-wrap gap-1.5 bg-bg py-1.5">
        {SECTIONS.map((sec) => (
          <a key={sec.id} href={`#${sec.id}`}
            className="rounded-full border border-line bg-surface2 px-2.5 py-1 text-[.8rem] text-fg2 hover:border-accent hover:text-accent">
            {sec.title}
          </a>
        ))}
      </nav>
      {error && <div className={errorText}>Could not load settings: {error.message}</div>}
      {isLoading && <div className="p-5 text-center text-[.85rem] text-fg3">Loading...</div>}
      {data && SECTIONS.map((sec) => (
        <section key={sec.id} id={`settings-${sec.id}`}
          className="mb-4 scroll-mt-14 rounded-lg border border-line bg-surface p-4">
          <h3 className="mb-0.5 text-base font-semibold">{sec.title}</h3>
          <p className="mb-2.5 text-[.8rem] text-fg3">{sec.intro}</p>
          <div className={sec.id === "modules" ? "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-6" : undefined}>
            {data.filter((s) => s.section === sec.id).map((s) => (
              <Field key={`${s.key}:${s.value}`} s={s} compact={sec.id === "modules"} />
            ))}
          </div>
          {sec.id === "appearance" && (
            <div className={field}>
              <div className={labelCol}>
                <span className={labelText}>Theme</span>
                <small className={hint}>System follows your device. Saved in this browser only.</small>
              </div>
              <ThemeToggle />
            </div>
          )}
          {sec.id === "ai" && <AiModelSettings />}
          {sec.id === "whatsapp" && <AutoTranscribeSettings />}
          {sec.id === "security" && <PasswordSettings />}
        </section>
      ))}
    </div>
  );
}
