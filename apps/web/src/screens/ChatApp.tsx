import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Lock, Send, DollarSign, Plus, Search, ShieldCheck, Info, X, ExternalLink, ArrowLeft, Fuel, EyeOff, Server, Coins, Loader2, Copy, Check, LogOut, UserPen, ChevronDown, MessageSquarePlus, AlertCircle,
} from "lucide-react";
import Logo from "../components/Logo";
import ProfileForm from "../components/ProfileForm";
import PaymentModal from "../components/PaymentModal";
import PrivacyMode from "../components/PrivacyMode";
import { go } from "../App";
import { api, explorerTx, short, type Chat, type Message, type Profile, type Status } from "../api";
import { getSession } from "../lib/session";

type ProfileMap = Record<string, Profile | null | undefined>;
const nameOf = (c: Chat, p?: Profile | null) => p?.displayName || (p ? `@${p.username}` : c.label);
const subOf = (c: Chat, p?: Profile | null) => (p ? `@${p.username}` : short(c.address));

const avatarColors = ["from-[#8bff16] to-[#4c9a00]", "from-[#ffffff] to-[#969696]", "from-[#c6ff8a] to-[#5fae12]", "from-[#d4d4d4] to-[#5a5a5a]", "from-[#a6ff52] to-[#262626]", "from-[#969696] to-[#262626]"];
const colorFor = (s: string) => avatarColors[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % avatarColors.length];

function Avatar({ chat, profile, size = 40 }: { chat: Chat; profile?: Profile | null; size?: number }) {
  if (profile?.avatar) {
    return <img src={profile.avatar} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-full border border-edge object-cover" />;
  }
  const initials = (profile?.displayName || profile?.username || chat.label).replace(/[^a-zA-Z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2) || chat.label.slice(0, 2);
  return (
    <div
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br ${colorFor(chat.address)} text-sm font-extrabold text-black`}
    >
      {initials.toUpperCase()}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-md" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 24, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 24 }} className="w-full max-w-md rounded-[28px] border border-line bg-panel-2 p-7" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-2xl font-extrabold text-fg">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg"><X size={18} /></button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

function ProofLink({ sig }: { sig: string | null }) {
  if (!sig) return <span className="opacity-70" title="Stored by the relayer; posted on-chain once the relayer is funded">stored · on-chain when relayer is funded</span>;
  return (
    <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:underline">
      proof <ExternalLink size={10} />
    </a>
  );
}

function Bubble({ m }: { m: Message }) {
  if (m.kind === "payment") {
    return (
      <div className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
        <div className="grad-border w-72 overflow-hidden">
          <div className="flex items-center gap-3 px-4 pt-4">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-grad text-black"><Coins size={20} /></div>
            <div>
              <div className="text-xs text-muted">{m.fromMe ? "Sent privately" : "Received privately"}</div>
              <div className="font-display text-2xl font-extrabold text-fg">{m.amount} {m.token}</div>
            </div>
          </div>
          {m.body && <div className="px-4 pt-2 text-sm text-fg">{m.body}</div>}
          <div className="px-4 pt-2"><span className="rounded-full border border-accent/50 px-2 py-0.5 text-[10px] font-semibold text-accent">Helius Privacy Rings</span></div>
          <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-black/30 px-4 py-2 text-[11px] text-muted">
            <EyeOff size={11} className="text-accent" /> Amount hidden on-chain
            <span className="ml-auto flex items-center gap-2">{m.time} · <ProofLink sig={m.sig} /></span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[60%] ${
          m.fromMe ? "rounded-br-md bg-accent font-medium text-black" : "rounded-bl-md border border-line bg-panel-2/80 text-fg backdrop-blur"
        }`}
      >
        {m.body}
        <div className={`mt-1 flex items-center justify-end gap-1.5 text-[10px] ${m.fromMe ? "text-black/60" : "text-muted"}`}>
          <Lock size={9} /> {m.time} · <ProofLink sig={m.sig} />
        </div>
      </div>
    </div>
  );
}

function PrivacyPanel({ onClose }: { onClose: () => void }) {
  const rows = [
    { icon: Lock, title: "Content is encrypted", body: "Messages are sealed end-to-end before they leave your device. Only the recipient can open them." },
    { icon: EyeOff, title: "Connections are hidden", body: "Each message goes to a one-time inbox, so observers can't see who you talk to." },
    { icon: Server, title: "Relayer pays gas", body: "Pispt's relayer submits and pays for transactions — your wallet never appears as the fee payer." },
    { icon: Coins, title: "Payments hide amounts", body: "Helius Privacy Rings hide how much you send. Deposits into and withdrawals from the ring are still public." },
    { icon: Info, title: "Your IP address", body: "Pispt never logs or stores IPs. Turn on Mixnet mode to hide your IP from our servers entirely." },
  ];
  return (
    <div className="absolute right-4 top-16 z-40 w-80 rounded-[24px] border border-line bg-panel-2/95 p-5 backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 font-display font-bold text-fg"><ShieldCheck size={16} className="text-accent" /> How private is this?</div>
        <button onClick={onClose} className="text-muted hover:text-fg"><X size={16} /></button>
      </div>
      <div className="space-y-4">
        {rows.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex gap-3">
            <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <div className="text-sm font-medium text-fg">{title}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted">{body}</div>
            </div>
          </div>
        ))}
      </div>
      <PrivacyMode className="mt-4" />
    </div>
  );
}

export default function ChatApp() {
  const me = api.me();
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState(api.mode === "mock" ? "c1" : "");
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [mobileList, setMobileList] = useState(false);
  const [profiles, setProfiles] = useState<ProfileMap>({});
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [editOpen, setEditOpen] = useState(() => window.location.hash === "#profile");
  const [status, setStatus] = useState<Status | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  useEffect(() => {
    const load = async () => {
      const cs = await api.listChats();
      setChats(cs);
      if (!activeRef.current && cs[0]) setActiveId(cs[0].id);
      if (activeRef.current) {
        setMsgs(await api.listMessages(activeRef.current));
        api.markRead(activeRef.current);
      }
    };
    load();
    api.getMyProfile().then(setMyProfile).catch(() => {});
    api.getStatus().then(setStatus).catch(() => {});
    return api.subscribe(() => { load(); });
  }, []);
  useEffect(() => {
    const missing = chats.filter((c) => !(c.address in profiles)).map((c) => c.address);
    if (!missing.length) return;
    api.getProfiles(missing).then((list) => {
      const found = Object.fromEntries(list.map((p) => [p.wallet, p]));
      setProfiles((m) => ({ ...m, ...Object.fromEntries(missing.map((w) => [w, found[w] ?? null])) }));
    }).catch(() => {});
  }, [chats]);
  useEffect(() => {
    const on = () => setEditOpen(window.location.hash === "#profile");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { setSendError(null); if (activeId) { api.listMessages(activeId).then(setMsgs); api.markRead(activeId); } else setMsgs([]); }, [activeId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const active = chats.find((c) => c.id === activeId);
  const refresh = async () => { setChats([...(await api.listChats())]); setMsgs(await api.listMessages(activeId)); };

  const send = async () => {
    const body = draft.trim();
    if (!body || !activeId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.sendText(activeId, body);
      setDraft("");
      refresh();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Couldn't send");
    } finally {
      setSending(false);
    }
  };

  const open = (id: string) => {
    setActiveId(id);
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    api.markRead(id);
    setMobileList(false);
  };

  const filtered = chats.filter((c) => (c.label + c.address + (profiles[c.address]?.username ?? "") + (profiles[c.address]?.displayName ?? "")).toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="flex h-full flex-col bg-ink">
      {/* Top bar */}
      <header className="relative flex h-16 shrink-0 items-center justify-between border-b border-line bg-panel/80 px-4 backdrop-blur">
        <Logo />
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-edge px-3 py-1 text-xs font-semibold text-fg sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {status ? status.network.charAt(0).toUpperCase() + status.network.slice(1) : "Devnet"}
          </span>
          {status && (status.mode === "local" || status.mode === "offline") && (
            <span className="hidden items-center gap-1.5 rounded-full border border-edge px-3 py-1 text-xs text-white/60 lg:flex" title={status.mode === "local" ? "Messages are stored by the relayer and posted on-chain once it is funded" : "Can't reach the relayer"}>
              {status.mode === "local" ? "Relayer: off-chain mode" : "Relayer: offline"}
            </span>
          )}
          <span className="hidden items-center gap-1.5 rounded-full border border-accent bg-accent px-3 py-1 text-xs font-bold text-black sm:flex">
            <Fuel size={12} /> Gas: free
          </span>
          <button
            onClick={() => setShowInfo((v) => !v)}
            className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-fg transition hover:border-accent/50 hover:text-accent"
          >
            <Info size={13} /> <span className="hidden md:inline">How private is this?</span>
          </button>
          <div className="relative">
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="flex items-center gap-2 rounded-full border border-edge bg-panel-2 py-1 pl-1 pr-2.5 text-xs transition hover:border-accent/50"
            >
              <Avatar chat={{ id: "me", label: me.label, address: me.address, lastMessage: "", time: "", unread: 0 }} profile={myProfile} size={22} />
              <span className="font-medium text-fg">{myProfile ? `@${myProfile.username}` : getSession()?.kind === "burner" ? "Burner (testing)" : me.label}</span>
              <span className="hidden font-mono text-muted lg:inline">{short(me.address)}</span>
              <ChevronDown size={12} className="text-muted" />
            </button>
            <AnimatePresence>
              {showMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ type: "spring", stiffness: 400, damping: 28 }}
                  className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-2xl border border-edge bg-panel-2 p-1.5 shadow-2xl"
                >
                  <div className="px-3 py-2">
                    <div className="truncate text-sm font-semibold text-fg">{myProfile?.displayName || (myProfile ? `@${myProfile.username}` : me.label)}</div>
                    <div className="font-mono text-[11px] text-muted">{short(me.address)}</div>
                  </div>
                  <button onClick={() => { setShowMenu(false); go("profile"); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-fg hover:bg-white/5">
                    <UserPen size={15} className="text-accent" /> Edit profile
                  </button>
                  <button onClick={() => { setShowMenu(false); api.disconnect(); go("landing"); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-fg">
                    <LogOut size={15} /> Disconnect
                  </button>
                  {getSession()?.kind === "burner" && (
                    <button onClick={() => { setShowMenu(false); api.disconnect({ forgetBurner: true }); go("landing"); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-white/45 hover:bg-white/5 hover:text-red-400">
                      <X size={15} /> Forget burner
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        {showInfo && <PrivacyPanel onClose={() => setShowInfo(false)} />}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className={`${mobileList ? "flex" : "hidden"} w-full flex-col border-r border-line bg-panel md:flex md:w-80 lg:w-96`}>
          <div className="flex items-center gap-2 p-3">
            <div className="flex flex-1 items-center gap-2 rounded-full border border-line bg-panel-2 px-4 py-2 focus-within:border-accent/40">
              <Search size={15} className="text-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" className="w-full bg-transparent text-sm outline-none placeholder:text-muted/70" />
            </div>
            <button onClick={() => setShowNew(true)} className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-bold text-black transition hover:scale-105 active:scale-95">
              <Plus size={16} /> New
            </button>
          </div>
          <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
            {chats.length === 0 && (
              <div className="px-4 py-10 text-center">
                <MessageSquarePlus size={28} className="mx-auto text-accent" />
                <p className="mt-3 text-sm font-semibold text-fg">No chats yet</p>
                <p className="mt-1 text-xs text-white/45">Start one with @username or a wallet address.</p>
              </div>
            )}
            {filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => open(c.id)}
                className={`relative flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${c.id === activeId ? "bg-accent/[0.06]" : "hover:bg-white/[0.03]"}`}
              >
                {c.id === activeId && <motion.span layoutId="activebar" className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-accent" />}
                <Avatar chat={c} profile={profiles[c.address]} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-fg">{nameOf(c, profiles[c.address])}</span>
                    <span className={`shrink-0 text-[11px] ${c.unread ? "text-accent" : "text-muted"}`}>{c.time}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] text-muted">{c.lastMessage}</span>
                    {c.unread > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-black">{c.unread}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="border-t border-line p-3 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/50 px-3 py-1 text-[11px] font-semibold text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent" /> Payments powered by Helius Privacy Rings</span>
          </div>
        </aside>

        {/* Conversation */}
        <section className={`${mobileList ? "hidden" : "flex"} min-w-0 flex-1 flex-col md:flex`}>
          {active && (
            <div className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-4">
              <button className="text-muted md:hidden" onClick={() => setMobileList(true)}><ArrowLeft size={20} /></button>
              <Avatar chat={active} profile={profiles[active.address]} size={36} />
              <div className="min-w-0">
                <div className="truncate font-display text-lg font-bold text-fg">{nameOf(active, profiles[active.address])}</div>
                <div className="truncate font-mono text-[11px] text-muted">{subOf(active, profiles[active.address])}{profiles[active.address] && ` · ${short(active.address)}`}</div>
              </div>
              <span className="ml-auto flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
                <ShieldCheck size={12} /> End-to-end encrypted
              </span>
            </div>
          )}

          <div className="scroll-thin flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top,rgba(139,255,22,0.035),transparent_60%)] px-4 py-6 sm:px-8">
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              <div className="mx-auto mb-2 flex items-center gap-1.5 rounded-full border border-line bg-panel-2/70 px-3 py-1 text-[11px] text-muted">
                <Lock size={10} /> Messages are end-to-end encrypted and delivered through one-time inboxes.
              </div>
              {!active && (
                <div className="mt-16 flex flex-col items-center text-center">
                  <div className="grid h-16 w-16 place-items-center rounded-2xl border border-edge bg-panel-2 text-accent"><MessageSquarePlus size={28} /></div>
                  <h3 className="mt-5 font-display text-3xl font-extrabold">No chats <span className="text-grad">yet.</span></h3>
                  <p className="mt-2 max-w-xs text-sm text-muted">Start one with @username or a wallet address.</p>
                  <button onClick={() => setShowNew(true)} className="mt-6 flex items-center gap-1.5 rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-black transition hover:scale-105 active:scale-95">
                    <Plus size={16} /> New chat
                  </button>
                </div>
              )}
              <AnimatePresence initial={true}>
                {msgs.map((m, i) => (
                  <motion.div key={m.id} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 26, delay: Math.min(i, 8) * 0.04 }}>
                    <Bubble m={m} />
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={endRef} />
            </div>
          </div>

          {/* Composer */}
          <div className={`shrink-0 border-t border-line bg-panel/70 p-3 backdrop-blur sm:p-4 ${active ? "" : "pointer-events-none opacity-40"}`}>
            {sendError && (
              <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <AlertCircle size={14} /> {sendError}
              </div>
            )}
            <div className="mx-auto flex max-w-3xl items-center gap-2">
              <button
                onClick={() => setShowPay(true)}
                title="Send private payment"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-accent/50 text-accent transition hover:scale-105 active:scale-95"
              >
                <DollarSign size={18} />
              </button>
              <div className="flex flex-1 items-center gap-2 rounded-full border border-line bg-panel-2 px-4 focus-within:border-accent/50">
                <Lock size={14} className="text-muted" />
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
                  maxLength={4000}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="Write a private message…"
                  className="h-11 w-full bg-transparent text-[15px] outline-none placeholder:text-muted/70"
                />
                {draft.length > 3500 && <span className={`shrink-0 font-mono text-[11px] ${draft.length >= 4000 ? "text-red-400" : "text-white/45"}`}>{draft.length}/4000</span>}
              </div>
              <button onClick={send} disabled={sending} className="bg-grad grid h-11 w-11 shrink-0 place-items-center rounded-full text-black transition hover:scale-110 active:scale-90">
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>
            <div className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted">Gas paid by Pispt · Encrypted on your device</div>
          </div>
        </section>
      </div>

      {showNew && (
        <NewChatModal
          onClose={() => setShowNew(false)}
          onCreate={async (addr) => { const existing = chats.find((x) => x.address === addr); if (existing) { open(existing.id); setShowNew(false); return; } const c = await api.startChat(addr); setChats([...(await api.listChats())]); open(c.id); setShowNew(false); }}
        />
      )}
      <AnimatePresence>
        {editOpen && (
          <EditProfilePanel
            profile={myProfile}
            address={me.address}
            onClose={() => go("app")}
            onSaved={(p) => { setMyProfile(p); go("app"); }}
          />
        )}
      </AnimatePresence>
      {showPay && active && (
        <PaymentModal
          toAddress={active.address}
          toName={nameOf(active, profiles[active.address])}
          onClose={() => setShowPay(false)}
          onPaid={async (note) => { await api.sendPayment(activeId, 0, "SOL"); if (note) await api.sendText(activeId, note); await refresh(); }}
        />
      )}
    </div>
  );
}

function NewChatModal({ onClose, onCreate }: { onClose: () => void; onCreate: (a: string) => Promise<void> }) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Profile | null | undefined>(undefined);
  const v = val.trim();
  const isAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  const isUser = /^@?[a-z0-9_]{3,20}$/i.test(v) && !isAddr;
  useEffect(() => {
    setFound(undefined);
    if (!isUser) return;
    let live = true;
    const t = setTimeout(async () => { const p = await api.findByUsername(v); if (live) setFound(p); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [v, isUser]);
  const target = isAddr ? v : found?.wallet;
  return (
    <Modal title="New private chat" onClose={onClose}>
      <label className="text-xs text-muted">@username or wallet address</label>
      <input
        autoFocus
        value={val}
        onChange={(e) => { setVal(e.target.value); setErr(null); }}
        placeholder="@maya or paste a Solana address…"
        className="mt-2 w-full rounded-2xl border border-edge bg-panel px-4 py-3 font-mono text-sm outline-none focus:border-accent/50"
      />
      {isUser && (
        <div className="mt-3 min-h-[52px]">
          {found === undefined && <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> Looking up…</div>}
          {found === null && <div className="text-xs text-red-400">No Pispt user with that username.</div>}
          {found && (
            <div className="flex items-center gap-3 rounded-2xl border border-accent/40 bg-panel p-3">
              <Avatar chat={{ id: "x", label: found.username, address: found.wallet, lastMessage: "", time: "", unread: 0 }} profile={found} size={32} />
              <div className="min-w-0 text-sm">
                <div className="truncate font-medium text-fg">{found.displayName || `@${found.username}`}</div>
                <div className="truncate font-mono text-[11px] text-muted">@{found.username} · {short(found.wallet)}</div>
              </div>
              <Check size={16} className="ml-auto text-accent" />
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-3 flex items-center gap-2 text-xs text-red-400"><AlertCircle size={13} /> {err}</div>}
      <p className="mt-3 text-xs text-muted">They'll need to have signed in to Pispt once so we can find their messaging key.</p>
      <button
        disabled={!target || busy}
        onClick={async () => {
          if (!target) return;
          setBusy(true);
          try { await onCreate(target); } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't start chat"); } finally { setBusy(false); }
        }}
        className="mt-5 w-full rounded-full bg-accent py-3 font-bold text-black transition hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Start chat
      </button>
    </Modal>
  );
}

function EditProfilePanel({ profile, address, onClose, onSaved }: { profile: Profile | null; address: string; onClose: () => void; onSaved: (p: Profile) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="scroll-thin absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-edge bg-panel-2 p-6 sm:p-8"
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="font-display text-3xl font-extrabold text-fg">Edit profile</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg"><X size={20} /></button>
        </div>
        <div className="mb-6 rounded-2xl border border-edge bg-panel p-3.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-white/45">Wallet address</div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{address}</span>
            <button onClick={copy} className="flex shrink-0 items-center gap-1 rounded-full border border-edge px-2.5 py-1 text-[11px] text-fg hover:border-accent/50">
              {copied ? <><Check size={12} className="text-accent" /> Copied</> : <><Copy size={12} /> Copy</>}
            </button>
          </div>
        </div>
        <ProfileForm key={profile?.updatedAt ?? 0} initial={profile} submitLabel="Save changes" onSaved={onSaved} />
      </motion.aside>
    </motion.div>
  );
}
