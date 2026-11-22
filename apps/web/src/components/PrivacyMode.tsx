import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import {
  getPrivacyMode, setPrivacyMode, onPrivacyModeChange,
  mixnetStatus, mixnetError, onMixnetStatusChange, retryMixnet,
  type MixnetStatus, type PrivacyMode as Mode,
} from "../lib/transport";

const STATUS: Record<MixnetStatus, { label: string; dot: string }> = {
  off: { label: "Off", dot: "bg-muted/60" },
  connecting: { label: "Connecting to mixnet…", dot: "bg-amber-400 animate-pulse" },
  ready: { label: "Connected via Nym", dot: "bg-accent shadow-[0_0_8px_rgba(139,255,22,0.8)]" },
  error: { label: "Couldn't reach the mixnet", dot: "bg-red-500" },
};

/** Toggle card: "Hide my IP (Mixnet, beta)". Fits the "How private is this?" panel or a profile menu. */
export default function PrivacyMode({ className = "" }: { className?: string }) {
  const [mode, setMode] = useState<Mode>(getPrivacyMode);
  const [status, setStatus] = useState<MixnetStatus>(mixnetStatus);

  useEffect(() => {
    const offMode = onPrivacyModeChange(setMode);
    const offStatus = onMixnetStatusChange(setStatus);
    // Sync in case state changed between render and subscribe.
    setMode(getPrivacyMode());
    setStatus(mixnetStatus());
    return () => { offMode(); offStatus(); };
  }, []);

  const on = mode === "mixnet";
  const s = STATUS[on ? status : "off"];

  return (
    <div className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <Network size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="pispt-mixnet-toggle" className="cursor-pointer text-sm font-medium text-fg">
              Hide my IP <span className="text-muted">(Mixnet, beta)</span>
            </label>
            <button
              id="pispt-mixnet-toggle"
              type="button"
              role="switch"
              aria-checked={on}
              onClick={() => setPrivacyMode(on ? "direct" : "mixnet")}
              className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                on ? "border-accent bg-accent" : "border-edge bg-panel-2"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-[18px] w-[18px] rounded-full transition-transform ${
                  on ? "translate-x-5 bg-black" : "translate-x-0 bg-muted"
                }`}
              />
            </button>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Routes Pispt traffic through the Nym mixnet so our servers can't see your IP. Slower; real-time updates switch to polling.
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted" aria-live="polite">
            <span className={`h-2 w-2 rounded-full ${s.dot}`} />
            <span>{s.label}</span>
            {on && status === "error" && (
              <button type="button" onClick={retryMixnet} className="ml-auto text-accent hover:text-accent-soft">
                Retry
              </button>
            )}
          </div>
          {on && status === "error" && mixnetError() && (
            <p className="mt-1 text-[11px] leading-snug text-red-400/80">{mixnetError()}</p>
          )}
        </div>
      </div>
    </div>
  );
}
