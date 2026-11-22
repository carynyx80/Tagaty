import { useEffect, useRef, useState } from "react";
import { Camera, Check, Loader2, Trash2, X, Info, AlertCircle } from "lucide-react";
import Pill from "./Pill";
import { api, USERNAME_RE, type Profile } from "../api";

async function resizeToDataUrl(file: File, size = 256): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const s = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Status = { state: "idle" | "checking" | "ok" | "bad"; reason?: string };

export default function ProfileForm({
  initial,
  submitLabel,
  onSaved,
}: {
  initial?: Profile | null;
  submitLabel: string;
  onSaved: (p: Profile) => void;
}) {
  const [username, setUsername] = useState(initial?.username ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [avatar, setAvatar] = useState<string | undefined>(initial?.avatar);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [drag, setDrag] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const name = username.trim();
    if (!name) { setStatus({ state: "idle" }); return; }
    if (!USERNAME_RE.test(name)) { setStatus({ state: "bad", reason: "3–20 characters: a–z, 0–9 or _" }); return; }
    setStatus({ state: "checking" });
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.checkUsername(name);
        if (live) setStatus(r.available ? { state: "ok" } : { state: "bad", reason: r.reason ?? "Not available" });
      } catch {
        if (live) setStatus({ state: "bad", reason: "Couldn't check availability — is the relayer running?" });
      }
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [username]);

  const pick = async (f?: File | null) => {
    if (f && f.type.startsWith("image/")) setAvatar(await resizeToDataUrl(f));
  };

  const submit = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const p = await api.saveProfile({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        avatar,
      });
      onSaved(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't save profile";
      if (/taken/i.test(msg)) setStatus({ state: "bad", reason: "Already taken" });
      setSaveErr(msg);
    } finally {
      setSaving(false);
    }
  };

  const optional = <span className="ml-1.5 rounded-full border border-edge px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">Optional</span>;
  const label = "mb-2 flex items-center text-xs font-semibold text-white/60";
  const input = "w-full rounded-2xl border border-edge bg-panel px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-white/30 focus:border-accent/60";

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <div className="flex items-center gap-5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
          className={`group relative grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-dashed transition ${drag ? "border-accent bg-accent/10" : "border-edge bg-panel hover:border-accent/60"}`}
          aria-label="Upload avatar"
        >
          {avatar ? (
            <>
              <img src={avatar} alt="" className="h-full w-full object-cover" />
              <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition group-hover:opacity-100"><Camera size={20} /></span>
            </>
          ) : (
            <Camera size={24} className="text-muted group-hover:text-accent" />
          )}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        <div>
          <div className={label + " mb-1"}>Avatar {optional}</div>
          <p className="text-xs text-white/45">Click or drop an image. Resized to 256×256 on your device.</p>
          {avatar && (
            <button onClick={() => setAvatar(undefined)} className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              <Trash2 size={12} /> Remove
            </button>
          )}
        </div>
      </div>

      {/* Username */}
      <div>
        <div className={label}>Username <span className="ml-1 text-accent">*</span></div>
        <div className={`flex items-center rounded-2xl border bg-panel pl-4 pr-3 transition focus-within:border-accent/60 ${status.state === "bad" ? "border-red-500/50" : "border-edge"}`}>
          <span className="text-[15px] text-muted">@</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ""))}
            maxLength={20}
            placeholder="your_name"
            className="w-full bg-transparent px-1 py-3 text-[15px] text-fg outline-none placeholder:text-white/30"
          />
          {status.state === "checking" && <Loader2 size={16} className="animate-spin text-muted" />}
          {status.state === "ok" && <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-black"><Check size={12} strokeWidth={3} /></span>}
          {status.state === "bad" && <span className="grid h-5 w-5 place-items-center rounded-full bg-red-500/80 text-white"><X size={12} strokeWidth={3} /></span>}
        </div>
        <p className={`mt-1.5 text-xs ${status.state === "bad" ? "text-red-400" : status.state === "ok" ? "text-accent" : "text-white/45"}`}>
          {status.state === "ok" ? "Available" : status.state === "bad" ? status.reason : status.state === "checking" ? "Checking availability…" : "Lowercase letters, numbers and _ · 3–20 characters"}
        </p>
      </div>

      {/* Display name */}
      <div>
        <div className={label}>Display name {optional}</div>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value.slice(0, 40))} placeholder="How friends see you" className={input} />
      </div>

      {/* Bio */}
      <div>
        <div className={label}>
          Bio {optional}
          <span className={`ml-auto text-[11px] font-normal ${bio.length >= 150 ? "text-accent" : "text-white/45"}`}>{bio.length}/160</span>
        </div>
        <textarea value={bio} onChange={(e) => setBio(e.target.value.slice(0, 160))} rows={3} placeholder="A line about you" className={input + " resize-none"} />
      </div>

      <div className="flex gap-2.5 rounded-2xl border border-edge bg-panel-2 p-3.5 text-xs leading-relaxed text-white/60">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        Your profile is public so friends can find you. Your messages and who you talk to stay private.
      </div>

      {saveErr && <div className="flex items-center gap-2 text-xs text-red-400"><AlertCircle size={13} /> {saveErr}</div>}
      <Pill variant="accent" disabled={status.state !== "ok" || saving} onClick={submit} className="w-full py-4 text-base">
        {saving ? <Loader2 size={18} className="animate-spin" /> : null} {submitLabel}
      </Pill>
    </div>
  );
}
