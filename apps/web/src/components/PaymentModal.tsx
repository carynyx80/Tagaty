import { useCallback, useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, Check, ExternalLink, Eye, EyeOff, Fuel, Info, KeyRound, Loader2, Lock, RefreshCw, Send, X } from "lucide-react";
import { api, explorerTx, short } from "../api";
import type { RingsContext } from "@primar/rings/client";
import {
  addFunds, depositPending, enablePrivatePayments, enabledBefore, formatSol, getBalances, getPaymentsStatus, lookupRingsAddress,
  maxPerPayment, parseSol, restorePayments, returnPending, sendPrivately, withdrawToWallet, type Balances, type RingsStatus,
} from "../lib/payments";

type Tab = "send" | "add" | "withdraw";
type Pending = { kind: Tab; lamports: bigint; note?: string };

export default function PaymentModal({
  toAddress, toName, onClose, onPaid,
}: {
  toAddress: string;
  toName: string;
  onClose: () => void;
  /** Called after a confirmed private transfer; posts the kind:"payment" chat message. */
  onPaid: (note?: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<RingsStatus | null>(null);
  const [ctx, setCtx] = useState<RingsContext | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [balErr, setBalErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("send");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [recipientReady, setRecipientReady] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; sigs: string[]; warn?: string } | null>(null);

  const network = status?.network ?? "devnet";
  const me = api.me().address;

  const refresh = useCallback(async (c: RingsContext) => {
    setBalErr(null);
    try { setBal(await getBalances(c)); } catch (e) { setBalErr(msg(e)); }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      if (api.mode === "mock") { setStatus({ enabled: false, network: "devnet", reason: "Private payments are not available in demo mode." }); return; }
      const s = await getPaymentsStatus();
      if (!live) return;
      setStatus(s);
      if (!s.enabled) return;
      try {
        const c = await restorePayments(s);
        if (!live || !c) return;
        setCtx(c);
        refresh(c);
      } catch (e) { if (live) setErr(msg(e)); }
    })();
    lookupRingsAddress(toAddress).then((r) => live && setRecipientReady(!!r)).catch(() => live && setRecipientReady(null));
    return () => { live = false; };
  }, [toAddress, refresh]);

  async function run(fn: (step: (m: string) => void) => Promise<void>) {
    setErr(null); setDone(null); setBusy("Working…");
    try { await fn((m) => setBusy(m)); } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }

  const enable = () => run(async (step) => {
    const c = await enablePrivatePayments(status!, step);
    setCtx(c);
    step("Reading your private balance…");
    await refresh(c);
  });

  function review() {
    setErr(null);
    let lamports: bigint;
    try { lamports = parseSol(amount); } catch (e) { setErr(msg(e)); return; }
    if (lamports <= 0n) { setErr("Enter an amount above 0"); return; }
    if (tab !== "withdraw" && lamports > maxPerPayment(network)) { setErr(`Limit is ${formatSol(maxPerPayment(network))} SOL per ${tab === "send" ? "payment" : "deposit"} on ${network}`); return; }
    if (tab !== "add" && bal && lamports > bal.privateLamports) { setErr(`Your private balance is ${formatSol(bal.privateLamports)} SOL`); return; }
    setConfirm({ kind: tab, lamports, note: note.trim() || undefined });
  }

  const execute = (p: Pending) => run(async (step) => {
    setConfirm(null);
    if (!ctx) throw new Error("Private payments not enabled");
    if (p.kind === "send") {
      const sig = await sendPrivately(ctx, toAddress, p.lamports, network, step);
      let warn: string | undefined;
      step("Posting the payment to your chat…");
      try { await onPaid(p.note); } catch (e) { warn = `Payment confirmed, but the chat message failed: ${msg(e)}`; }
      setDone({ title: `Sent ${formatSol(p.lamports)} SOL privately`, sigs: [sig], warn });
      setAmount(""); setNote("");
    } else if (p.kind === "add") {
      const r = await addFunds(ctx, p.lamports, network, step);
      setDone({ title: `Added ${formatSol(p.lamports)} SOL to your private balance`, sigs: [r.topUp, r.deposit] });
      setAmount("");
    } else {
      const sig = await withdrawToWallet(ctx, p.lamports, step);
      setDone({ title: `Withdrew ${formatSol(p.lamports)} SOL to ${short(me)}`, sigs: [sig] });
      setAmount("");
    }
    await refresh(ctx);
  });

  const pending = bal?.pendingPublicLamports ?? 0n;

  return (
    <Shell title="Private payments" onClose={busy ? () => {} : onClose}>
      {!status && <Row><Loader2 size={14} className="animate-spin" /> Checking Privacy Rings…</Row>}

      {status && !status.enabled && (
        <Note icon={<Info size={14} className="mt-0.5 shrink-0 text-accent" />}>{status.reason ?? "Private payments are unavailable right now."}</Note>
      )}

      {status?.enabled && !ctx && (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-white/75">
            {enabledBefore() ? "Unlock private payments for this session" : "Enable private payments"} with one wallet signature. Your Rings key is derived in this browser and never leaves it.
          </p>
          <ul className="space-y-1.5 rounded-2xl border border-line bg-panel p-3.5 text-xs text-white/70">
            <li className="flex gap-2"><KeyRound size={13} className="mt-0.5 shrink-0 text-accent" /> Sign once to derive your key{enabledBefore() ? "" : ", once more to publish your Rings address to contacts"}.</li>
            <li className="flex gap-2"><Eye size={13} className="mt-0.5 shrink-0 text-accent" /> Public: your Rings address is registered on Solana and linked to your wallet in Pispt's directory.</li>
            <li className="flex gap-2"><Fuel size={13} className="mt-0.5 shrink-0 text-accent" /> Network fees are paid by Pispt.</li>
          </ul>
          <Primary onClick={enable} disabled={!!busy}>{busy ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={16} />} {enabledBefore() ? "Unlock" : "Enable private payments"}</Primary>
        </div>
      )}

      {status?.enabled && ctx && (
        <>
          <div className="mb-4 rounded-2xl border border-line bg-panel p-4">
            <div className="flex items-center justify-between text-xs text-muted">
              <span className="flex items-center gap-1.5"><EyeOff size={12} className="text-accent" /> Private balance</span>
              <button onClick={() => refresh(ctx)} className="flex items-center gap-1 hover:text-fg" disabled={!!busy}><RefreshCw size={11} /> refresh</button>
            </div>
            <div className="mt-1 font-display text-3xl font-extrabold text-fg">{bal ? `${formatSol(bal.privateLamports)} SOL` : balErr ? "Unavailable" : <Loader2 size={20} className="animate-spin" />}</div>
            {balErr && <div className="mt-1 text-xs text-red-400">{balErr}</div>}
            <div className="mt-1 font-mono text-[10px] text-muted">Rings address {short(ctx.account.owner)}</div>
          </div>

          {pending > 0n && !busy && (
            <Note icon={<AlertCircle size={14} className="mt-0.5 shrink-0 text-accent" />}>
              {formatSol(pending)} SOL is sitting (publicly) at your Rings address, not yet deposited.
              <div className="mt-2 flex gap-2">
                <button className="rounded-full bg-accent px-3 py-1 font-bold text-black" onClick={() => run(async (s) => { const sig = await depositPending(ctx, pending, s); setDone({ title: "Deposited", sigs: [sig] }); await refresh(ctx); })}>Deposit it</button>
                <button className="rounded-full border border-line px-3 py-1" onClick={() => run(async (s) => { const sig = await returnPending(ctx, pending, s); setDone({ title: "Returned to your wallet", sigs: [sig] }); await refresh(ctx); })}>Return to wallet</button>
              </div>
            </Note>
          )}

          <div className="mb-4 flex rounded-full border border-line bg-panel p-1 text-sm">
            {([["send", "Send", Send], ["add", "Add funds", ArrowDownToLine], ["withdraw", "Withdraw", ArrowUpFromLine]] as const).map(([k, label, Icon]) => (
              <button key={k} disabled={!!busy} onClick={() => { setTab(k); setConfirm(null); setErr(null); setDone(null); }} className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 font-bold ${tab === k ? "bg-accent text-black" : "text-muted"}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          {tab === "send" && recipientReady === false && (
            <Note icon={<Info size={14} className="mt-0.5 shrink-0 text-accent" />}>{toName} hasn't enabled private payments yet. They need to open Pay once.</Note>
          )}

          {!confirm && (
            <fieldset disabled={!!busy}>
              <label className="text-xs text-muted">{tab === "send" ? `To ${toName}` : tab === "add" ? `From your wallet ${short(me)}` : `To your wallet ${short(me)}`}</label>
              <div className="mt-1 flex items-center gap-2">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0"
                  className="w-full rounded-2xl border border-line bg-panel px-4 py-3 font-display text-3xl font-extrabold text-fg outline-none focus:border-accent/50" />
                <span className="font-bold text-muted">SOL</span>
              </div>
              {tab === "send" && (
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an encrypted note (optional)"
                  className="mt-3 w-full rounded-2xl border border-line bg-panel px-4 py-3 text-sm outline-none focus:border-accent/50" />
              )}
              <div className="mt-2 text-[11px] text-muted">
                {tab === "withdraw" ? "Withdrawals go only to your own connected wallet." : `Limit ${formatSol(maxPerPayment(network))} SOL per ${tab === "send" ? "payment" : "deposit"} on ${network}.`}
              </div>
              <Primary onClick={review} disabled={!amount || (tab === "send" && recipientReady === false)}>Review</Primary>
            </fieldset>
          )}

          {confirm && !busy && (
            <div className="space-y-3">
              <div className="rounded-2xl border border-accent/50 p-4 text-sm">
                <div className="text-xs text-muted">{confirm.kind === "send" ? "Send privately" : confirm.kind === "add" ? "Add funds (public step)" : "Withdraw (public step)"}</div>
                <div className="font-display text-3xl font-extrabold text-fg">{formatSol(confirm.lamports)} SOL</div>
                <div className="mt-1 text-xs text-white/70">
                  {confirm.kind === "send" && <>to {toName} · {short(toAddress)}</>}
                  {confirm.kind === "add" && <>from your wallet {short(me)} → your Rings address {short(ctx.account.owner)} → private balance</>}
                  {confirm.kind === "withdraw" && <>from your private balance → your wallet {short(me)}</>}
                </div>
                <div className="mt-1 text-xs text-white/70">Network fee payer: <span className="font-semibold text-accent">Pispt</span> ({short(status.feePayer ?? "")})</div>
              </div>
              <div className="space-y-1.5 rounded-2xl border border-line bg-panel p-3.5 text-xs text-white/70">
                {confirm.kind === "send" && <>
                  <div className="flex gap-2"><EyeOff size={13} className="mt-0.5 shrink-0 text-accent" /> Hidden on-chain: the amount{confirm.note ? " and your note (sent end-to-end encrypted)" : ""}.</div>
                  <div className="flex gap-2"><Eye size={13} className="mt-0.5 shrink-0 text-accent" /> Visible on-chain: that your Rings address made a private transfer; accounts involved may be identifiable.</div>
                </>}
                {confirm.kind === "add" && <div className="flex gap-2"><Eye size={13} className="mt-0.5 shrink-0 text-accent" /> Public: deposits show the amount, your wallet and your Rings address on-chain. Your wallet will ask you to approve the transfer.</div>}
                {confirm.kind === "withdraw" && <div className="flex gap-2"><Eye size={13} className="mt-0.5 shrink-0 text-accent" /> Public: withdrawals show the amount and your wallet on-chain.</div>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setConfirm(null)} className="flex-1 rounded-full border border-line py-3 font-bold text-muted hover:text-fg">Back</button>
                <button onClick={() => execute(confirm)} className="bg-grad flex flex-[2] items-center justify-center gap-2 rounded-full py-3 font-bold text-black"><Lock size={15} /> Confirm</button>
              </div>
            </div>
          )}
        </>
      )}

      {busy && <Row><Loader2 size={14} className="animate-spin text-accent" /> {busy}</Row>}
      {err && <div className="mt-3 flex items-start gap-2 break-words text-xs text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> <span className="min-w-0">{err}</span></div>}
      {done && (
        <div className="mt-3 rounded-2xl border border-accent/50 p-3 text-xs">
          <div className="flex items-center gap-2 font-semibold text-fg"><Check size={14} className="text-accent" /> {done.title}</div>
          {done.sigs.map((s) => (
            <a key={s} href={explorerTx(s)} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 font-mono text-muted hover:underline">{short(s)} <ExternalLink size={10} /></a>
          ))}
          {done.warn && <div className="mt-1 text-red-400">{done.warn}</div>}
        </div>
      )}
    </Shell>
  );
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-md" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 24, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 24 }} className="w-full max-w-md rounded-[28px] border border-line bg-panel-2 p-7" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-2xl font-extrabold text-fg">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg"><X size={18} /></button>
        </div>
        {children}
        <div className="mt-4 text-center text-[10px] text-muted">Powered by <span className="text-accent">Helius Privacy Rings</span></div>
      </motion.div>
    </motion.div>
  );
}
const Row = ({ children }: { children: ReactNode }) => <div className="mt-3 flex items-center gap-2 text-xs text-white/70">{children}</div>;
const Note = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <div className="mb-4 flex gap-2.5 rounded-2xl border border-edge bg-panel p-3.5 text-xs leading-relaxed text-white/70">{icon}<div>{children}</div></div>
);
const Primary = ({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) => (
  <button onClick={onClick} disabled={disabled} className="bg-grad mt-4 flex w-full items-center justify-center gap-2 rounded-full py-3.5 font-bold text-black transition hover:scale-[1.02] active:scale-95 disabled:opacity-40">{children}</button>
);
