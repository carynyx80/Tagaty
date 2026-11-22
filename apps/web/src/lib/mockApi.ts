import { chats as mockChats, messages as mockMessages, profiles as mockProfiles, RESERVED_USERNAMES, ME } from "../mock";
import type { PrimarApi, Chat, Message, Profile } from "../api";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeSig = () =>
  Array.from({ length: 88 }, () => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Math.floor(Math.random() * 58)]).join("");
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

let chats = [...mockChats];
let messages = [...mockMessages];
let profiles = [...mockProfiles];

export const mockApi: PrimarApi = {
  mode: "mock",
  me: () => ME,
  async getStatus() { return { network: "devnet", mode: "mock", rings: { enabled: true } }; },
  subscribe() { return () => {}; },
  markRead() {},
  async getProfiles(wallets) { return profiles.filter((p) => wallets.includes(p.wallet)); },
  disconnect() {},
  async listChats() { return chats; },
  async listMessages(chatId) { return messages.filter((m) => m.chatId === chatId); },
  async sendText(chatId, body) {
    await delay(250);
    const m: Message = { id: crypto.randomUUID(), chatId, fromMe: true, kind: "text", body, time: now(), sig: fakeSig() };
    messages = [...messages, m];
    chats = chats.map((c) => (c.id === chatId ? { ...c, lastMessage: body, time: "now" } : c));
    return m;
  },
  async sendPayment(chatId, amount, token, note) {
    await delay(400);
    const m: Message = { id: crypto.randomUUID(), chatId, fromMe: true, kind: "payment", body: note ?? "", amount, token, time: now(), sig: fakeSig() };
    messages = [...messages, m];
    chats = chats.map((c) => (c.id === chatId ? { ...c, lastMessage: `Sent ${amount} ${token} privately`, time: "now" } : c));
    return m;
  },
  async startChat(address) {
    const c: Chat = { id: crypto.randomUUID(), label: `${address.slice(0, 4)}…${address.slice(-4)}`, address, lastMessage: "New private chat", time: "now", unread: 0 };
    chats = [c, ...chats];
    return c;
  },
  async deriveKey() { await delay(900); return { msgPub: "mock-msg-pub", hasProfile: false }; },
  async getMyProfile() { return profiles.find((p) => p.wallet === ME.address) ?? null; },
  async saveProfile(p) {
    await delay(300);
    const next: Profile = { ...p, wallet: ME.address, updatedAt: Date.now() };
    profiles = [...profiles.filter((x) => x.wallet !== ME.address), next];
    return next;
  },
  async checkUsername(raw) {
    await delay(250);
    const name = raw.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(name)) return { available: false, reason: "3–20 characters: a–z, 0–9 or _" };
    if (RESERVED_USERNAMES.includes(name)) return { available: false, reason: "This username is reserved" };
    const owner = profiles.find((p) => p.username === name);
    if (owner && owner.wallet !== ME.address) return { available: false, reason: "Already taken" };
    return { available: true };
  },
  async getProfile(wallet) { return profiles.find((p) => p.wallet === wallet) ?? null; },
  async findByUsername(raw) {
    const name = raw.trim().replace(/^@/, "").toLowerCase();
    return profiles.find((p) => p.username === name) ?? null;
  },
};

