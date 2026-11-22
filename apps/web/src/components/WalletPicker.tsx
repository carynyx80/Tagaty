import { useState } from "react";
import { motion } from "motion/react";
import { X, Flame, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import type { Wallet } from "@wallet-standard/base";
import { connectWallet, useBurner } from "../lib/session";

export default function WalletPicker({ wallets, onClose, onDone }: { wallets: Wallet[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (w: Wallet) => {
    setBusy(w.name);
    setErr(null);
    try {
      await connectWallet(w);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Connection rejected");
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-md" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
        className="w-full max-w-sm rounded-[28px] border border-edge bg-panel-2 p-7 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-2xl font-extrabold text-fg">{wallets.length ? "Choose a wallet" : "No wallet found"}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg"><X size={18} /></button>
        </div>
        {wallets.length ? (
          <div className="space-y-2">
            {wallets.map((w) => (
              <button
                key={w.name}
                disabled={!!busy}
                onClick={() => pick(w)}
                className="flex w-full items-center gap-3 rounded-2xl border border-edge bg-panel px-4 py-3 text-sm font-semibold text-fg transition hover:border-accent/50 disabled:opacity-50"
              >
                <img src={w.icon} alt="" className="h-7 w-7 rounded-lg" />
                {w.name}
                {busy === w.name && <Loader2 size={16} className="ml-auto animate-spin text-accent" />}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Pispt works with Solana wallets like Phantom, Backpack and Solflare. Install one, then reload this page.
            <a href="https://phantom.app" target="_blank" rel="noreferrer" className="mt-3 flex items-center gap-1 font-semibold text-accent hover:underline">
              Get Phantom <ExternalLink size={13} />
            </a>
          </p>
        )}
        {err && <div className="mt-3 flex items-center gap-2 text-xs text-red-400"><AlertCircle size={13} /> {err}</div>}
        <div className="mt-5 border-t border-line pt-5">
          <button
            onClick={() => { useBurner(); onDone(); }}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-edge px-4 py-3 text-sm font-semibold text-fg transition hover:border-accent/50"
          >
            <Flame size={16} className="text-accent" /> Try with burner wallet
          </button>
          <p className="mt-2 text-center text-[11px] text-white/45">Burner (testing): a throwaway key stored in this browser.</p>
        </div>
      </motion.div>
    </motion.div>
  );
}
