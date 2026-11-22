import { Lock, EyeOff, Fuel, Wallet, ArrowRight, ShieldAlert, Sparkles } from "lucide-react";
import { motion, type Variants } from "motion/react";
import { useState, type ReactNode } from "react";
import type { Wallet as StdWallet } from "@wallet-standard/base";
import WalletPicker from "../components/WalletPicker";
import { listWallets, connectWallet, hasIdentity } from "../lib/session";
import { MOCK } from "../api";
import Logo from "../components/Logo";
import Pill from "../components/Pill";
import { go } from "../App";

const ease = [0.22, 1, 0.36, 1] as const;
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease } },
};
const stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.09 } } };

function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }} className={className}>
      {children}
    </motion.div>
  );
}

const marqueeItems = ["END-TO-END ENCRYPTED", "ZERO GAS", "HIDDEN CONNECTIONS", "POWERED BY HELIUS PRIVACY RINGS", "NO SEED PHRASE", "AMOUNTS HIDDEN"];

function Marquee() {
  const row = [...marqueeItems, ...marqueeItems];
  return (
    <div className="relative overflow-hidden border-y border-black/10 bg-accent py-4 text-black">
      <div className="marquee flex w-max gap-8 whitespace-nowrap font-display text-2xl font-extrabold sm:text-3xl">
        {[...row, ...row].map((t, i) => (
          <span key={i} className="flex items-center gap-8">
            {t} <span className="text-black/50">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Landing() {
  const [picker, setPicker] = useState<StdWallet[] | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const connect = async () => {
    setConnErr(null);
    if (MOCK) return go("onboard");
    const ws = listWallets();
    if (ws.length === 1) {
      try { await connectWallet(ws[0]); go("onboard"); } catch (e) { setConnErr(e instanceof Error ? e.message : "Connection rejected"); setPicker(ws); }
      return;
    }
    setPicker(ws);
  };
  return (
    <div className="relative min-h-full overflow-x-hidden bg-ink">
      {/* blobs */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[900px] overflow-hidden">
        <div className="warm-light" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      </div>

      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5">
        <Logo />
        <div className="flex items-center gap-2 text-xs">
          <span className="hidden rounded-full border border-accent/50 px-3 py-1 font-semibold text-accent sm:inline">Live on Solana</span>
          <Pill variant="ghost" onClick={() => (MOCK || hasIdentity() ? go("app") : connect())} className="px-4 py-2 text-sm">
            Open app <ArrowRight size={14} />
          </Pill>
        </div>
      </header>

      <main className="relative z-10">
        <section className="mx-auto max-w-7xl px-5 pb-20 pt-14 text-center sm:pt-20">
          <Reveal>
            <motion.img variants={fadeUp} src="/logo.jpg" alt="Pispt logo" className="mx-auto mb-6 h-36 w-36 object-cover mix-blend-screen [mask-image:radial-gradient(circle,black_38%,transparent_62%)] sm:h-52 sm:w-52" />
            <motion.div variants={fadeUp} className="mx-auto mb-8 inline-flex items-center gap-2 rounded-full border border-accent/50 px-5 py-2 text-sm font-semibold text-fg">
              <span className="h-2 w-2 rounded-full bg-accent" />
              Powered by Helius Privacy Rings on Solana
            </motion.div>
            <motion.h1 variants={fadeUp} className="font-display text-[72px] font-extrabold leading-[0.88] sm:text-[120px] lg:text-[160px]">
              Say <span className="text-grad">anything.</span>
              <br />
              Reveal <span className="italic text-grad">nothing.</span>
            </motion.h1>
            <motion.p variants={fadeUp} className="mx-auto mt-8 max-w-xl text-lg text-muted">
              <span className="font-semibold text-fg">Pispt:</span> gas-free private messaging on Solana, powered by Helius Privacy Rings. Send and receive messages.
            </motion.p>
            <motion.div variants={fadeUp} className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Pill variant="accent" onClick={connect} className="w-full px-8 py-4 text-base sm:w-auto">
                <Wallet size={18} /> Connect wallet
              </Pill>
            </motion.div>
          </Reveal>
        </section>

        <Marquee />

        {/* Bento */}
        <section className="mx-auto max-w-7xl px-5 py-24">
          <Reveal className="mb-10">
            <motion.h2 variants={fadeUp} className="font-display text-5xl font-extrabold sm:text-7xl">
              Private by <span className="text-grad">default.</span>
            </motion.h2>
          </Reveal>
          <Reveal className="grid auto-rows-[minmax(220px,auto)] gap-4 md:grid-cols-6">
            <motion.div variants={fadeUp} className="card relative overflow-hidden p-8 md:col-span-4 md:row-span-2">
              <Lock size={36} className="text-accent" />
              <h3 className="mt-6 font-display text-4xl font-extrabold sm:text-5xl">End-to-end encrypted</h3>
              <p className="mt-4 max-w-md text-muted">Only you and the people you choose can read a message. Not us, not the relayer, not the chain. Keys are derived in your browser and never leave it.</p>
              <div className="mt-8 space-y-2 font-mono text-xs">
                <div className="w-fit rounded-xl bg-accent px-4 py-2 text-black">gm, dinner tonight?</div>
                <div className="w-fit rounded-xl border border-line bg-panel-2 px-4 py-2 text-muted">PRM1:AXk9f2Lw…q8Zr0==</div>
              </div>
            </motion.div>
            <motion.div variants={fadeUp} className="card p-8 md:col-span-2">
              <EyeOff size={30} className="text-accent" />
              <h3 className="mt-5 font-display text-3xl font-extrabold">Hidden connections</h3>
              <p className="mt-3 text-sm text-muted">One-time inboxes mean nobody watching Solana can tell who talks to whom.</p>
            </motion.div>
            <motion.div variants={fadeUp} className="card relative overflow-hidden p-8 md:col-span-2">
              <Fuel size={30} className="text-accent" />
              <h3 className="mt-5 font-display text-3xl font-extrabold">
                Zero <span className="text-grad">gas</span>
              </h3>
              <p className="mt-3 text-sm text-muted">Pispt's relayer pays every fee. No SOL needed to chat.</p>
            </motion.div>
            <motion.div variants={fadeUp} className="card flex items-center justify-between gap-6 p-8 md:col-span-6">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent"><Sparkles size={14} /> Helius Privacy Rings</div>
                <h3 className="mt-3 font-display text-3xl font-extrabold sm:text-4xl">Private payments on Helius Privacy Rings. Amounts encrypted on Solana.</h3>
                <p className="mt-3 text-sm text-muted">Send SOL or USDC inside a chat. Messages are end-to-end encrypted by Pispt; Rings keep payment amounts hidden on-chain.</p>
              </div>
              <div className="grad-border hidden shrink-0 px-6 py-4 sm:block">
                <div className="text-xs text-muted">Sent privately</div>
                <div className="font-display text-3xl font-extrabold">0.5 SOL</div>
              </div>
            </motion.div>
          </Reveal>
        </section>

        {/* Manifesto */}
        <section className="mx-auto max-w-4xl px-5 pb-28">
          <Reveal className="card p-8 sm:p-12">
            <motion.div variants={fadeUp} className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent">
              <ShieldAlert size={14} /> Manifesto
            </motion.div>
            <motion.p variants={fadeUp} className="font-display text-3xl font-bold leading-tight sm:text-4xl">
              Every day, trillions of messages are exposed to <span className="text-grad">snooping.</span>
            </motion.p>
            <motion.p variants={fadeUp} className="mt-6 text-[15px] leading-relaxed text-muted">
              In 2024, the <span className="font-semibold text-fg">Salt Typhoon</span> breach put state-backed hackers inside at least nine US telecom carriers, reaching call records and live communications. The FBI and CISA responded with advice that used to sound paranoid: use end-to-end encrypted messaging.
            </motion.p>
            <motion.p variants={fadeUp} className="mt-8 font-semibold text-fg">We believe:</motion.p>
            <ul className="mt-4 space-y-3">
              {[
                "What you send stays between you and the people you choose.",
                "Who you send it to is nobody else's business.",
                "What you receive, words or money, reveals nothing to onlookers.",
                "Privacy shouldn't cost gas.",
              ].map((b) => (
                <motion.li variants={fadeUp} key={b} className="flex gap-3 text-fg">
                  <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-grad" />
                  {b}
                </motion.li>
              ))}
            </ul>
            <motion.div variants={fadeUp} className="mt-10">
              <Pill variant="grad" onClick={connect}>
                Start a private conversation <ArrowRight size={16} />
              </Pill>
            </motion.div>
          </Reveal>
        </section>
      </main>

      {picker && <WalletPicker wallets={picker} onClose={() => setPicker(null)} onDone={() => { setPicker(null); go("onboard"); }} />}
      {connErr && !picker && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-red-500/30 bg-panel-2 px-4 py-2 text-xs text-red-300">{connErr}</div>}
      <footer className="relative z-10 border-t border-line py-8 text-center text-xs text-muted">
        <span className="font-display text-base font-bold text-fg">Pispt</span> · Built on Solana · Powered by <span className="font-semibold text-accent">Helius Privacy Rings</span>
      </footer>
    </div>
  );
}
