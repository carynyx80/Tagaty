import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const APP_NAME = "Pispt" as const;
export const TREASURY = "6T9AvUXqBnSrSxwdLmUnxttgdkSqyWDUQUcYqZf7mkpv";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MAX_ENVELOPE_CHARS = 700;
export const MIN_ONCHAIN_LAMPORTS = 1_000_000; // 0.001 SOL

/** apps/relayer */
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** repo root */
export const REPO_ROOT = path.resolve(PKG_DIR, "..", "..");

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  dotenv.config({ path: path.join(PKG_DIR, ".env"), quiet: true } as any);
}

export type Network = "devnet" | "mainnet";

export function getNetwork(): Network {
  return process.env.SOLANA_NETWORK === "mainnet" ? "mainnet" : "devnet";
}

/** RPC URL per CONTRACT: Helius if key set, else public devnet. */
export function getRpcUrl(network: Network = getNetwork()): string {
  const key = process.env.HELIUS_API_KEY;
  if (key) return `https://${network}.helius-rpc.com/?api-key=${key}`;
  return network === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}

/** Safe-to-log form of the RPC URL (never prints the API key). */
export function redactRpcUrl(url: string): string {
  return url.replace(/api-key=[^&]+/, "api-key=***");
}

/** Relative paths are resolved against the repo root (so the default matches CONTRACT.md). */
export function resolveRepoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export function getKeypairPath(): string {
  return resolveRepoPath(process.env.RELAYER_KEYPAIR_PATH || "apps/relayer/.relayer-keypair.json");
}

export function getPort(): number {
  const n = Number(process.env.PORT);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}

export function getMessageRatePerMin(): number {
  const n = Number(process.env.MESSAGE_RATE_PER_MIN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
}

export function getDailyCap(): number {
  const n = Number(process.env.DAILY_MESSAGE_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
}
