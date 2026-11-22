import { useState } from "react";
import { motion } from "motion/react";
import { KeyRound, Check, Loader2, PenLine, AlertCircle } from "lucide-react";
import { getSession } from "../lib/session";
import Logo from "../components/Logo";
import Pill from "../components/Pill";
import { go } from "../App";
import { api, short } from "../api";

export default function Onboard() {
  const [state, setState] = useState<"idle" | "signing" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const me = api.me();
  const session = getSession();

  const sign = async () => {
    setState("signing");
    setErr(null);
    try {
      const r = await api.deriveKey();
      setState("done");
      setTimeout(() => go(r.hasProfile ? "app" : "profile-setup"), 700);
    } catch (e) {
      setState("idle");
      setErr(e instanceof Error ? e.message : "Signing failed");
    }
  };

  return (
    <div className="relative flex min-h-full flex-col overflow-hidden bg-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="warm-light" />
      </div>
      <header className="relative z-10 mx-auto w-full max-w-7xl px-5 py-5">
        <Logo />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-20">
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 160, damping: 20 }}
          className="card w-full max-w-lg p-8 sm:p-10"
        >
          <div className="mb-8 flex items-center gap-2 text-xs text-muted">
            <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 font-mono text-accent">● {short(me.address)}</span>
            {session?.kind === "burner" ? "Burner (testing)" : session?.label ?? ""} connected
          </div>
          <div className="bg-grad mb-6 grid h-16 w-16 place-items-center rounded-2xl text-black">
            <KeyRound size={28} />
          </div>
          <h1 className="font-display text-4xl font-extrabold leading-[0.95] sm:text-5xl">
            Sign once to create your <span className="text-grad">private key.</span>
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-muted">
            Your wallet signs a fixed message. Pispt turns that signature into a messaging key — right here in your browser. It never leaves your device.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-fg">
            {["No seed phrase to write down", "Same wallet → same key on any device", "Signing is free — no transaction, no gas"].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-black"><Check size={12} strokeWidth={3} /></span> {t}
              </li>
            ))}
          </ul>
          <Pill variant="accent" onClick={sign} disabled={state !== "idle"} className="mt-10 w-full py-4 text-base">
            {state === "idle" && (<><PenLine size={18} /> Sign message</>)}
            {state === "signing" && (<><Loader2 size={18} className="animate-spin" /> Waiting for signature…</>)}
            {state === "done" && (<><Check size={18} /> Key created</>)}
          </Pill>
          {err && <div className="mt-3 flex items-center justify-center gap-2 text-xs text-red-400"><AlertCircle size={13} /> {err}</div>}
          <p className="mt-4 text-center font-mono text-[11px] text-muted">Off-chain signature · no transaction · no gas</p>
        </motion.div>
      </main>
    </div>
  );
}
