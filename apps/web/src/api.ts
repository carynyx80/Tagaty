import type { Chat, Message, Profile } from "./mock";
import { mockApi } from "./lib/mockApi";
import { realApi } from "./lib/real";

export type { Chat, Message, Profile };

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export type Status = {
  network: string;
  mode: "onchain" | "local" | "offline" | "mock";
  rings: { enabled: boolean; reason?: string };
};

/** Data layer used by the UI. `?mock=1` swaps in the mock implementation. */
export interface PrimarApi {
  mode: "real" | "mock";
  me(): { address: string; label: string };
  getStatus(): Promise<Status>;
  /** Called whenever chats/messages change (new message received, sent, etc). */
  subscribe(cb: () => void): () => void;
  listChats(): Promise<Chat[]>;
  listMessages(chatId: string): Promise<Message[]>;
  markRead(chatId: string): void;
  sendText(chatId: string, body: string): Promise<Message>;
  sendPayment(chatId: string, amount: number, token: "SOL" | "USDC", note?: string): Promise<Message>;
  startChat(address: string): Promise<Chat>;
  /** Sign once → derive messaging key → register with the relayer. */
  deriveKey(): Promise<{ msgPub: string; hasProfile: boolean }>;
  getMyProfile(): Promise<Profile | null>;
  saveProfile(p: Omit<Profile, "wallet" | "updatedAt">): Promise<Profile>;
  checkUsername(name: string): Promise<{ available: boolean; reason?: string }>;
  getProfile(wallet: string): Promise<Profile | null>;
  getProfiles(wallets: string[]): Promise<Profile[]>;
  findByUsername(name: string): Promise<Profile | null>;
  disconnect(opts?: { forgetBurner?: boolean }): void;
}

export const MOCK = (() => {
  try { return new URLSearchParams(window.location.search).has("mock"); } catch { return false; }
})();

export const api: PrimarApi = MOCK ? mockApi : realApi;

let currentNetwork = "devnet";
/** Called once the relayer reports its network, so explorer links match it. */
export const setNetwork = (n: string) => { currentNetwork = n; };
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${currentNetwork === "mainnet" ? "" : `?cluster=${currentNetwork}`}`;
export const short = (a: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
