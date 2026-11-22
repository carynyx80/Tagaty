// Shared constants for Pispt Rings payments. Browser + Node safe (no SDK import here,
// so the relayer can use the validator without loading the SPR SDK / its wasm hasher).
//
// Program IDs verified against @heliuslabs/spr@0.9.0-alpha
// (dist/interface/program.js: SHIELDED_POOL_PROGRAM_ID, USER_REGISTRY_PROGRAM_ID).

/** Solana Privacy Rings shielded-pool ("Privacy Program"). */
export const PRIVACY_PROGRAM_ID = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
/** Solana Privacy Rings user registry (Solana address -> shielded keys). */
export const REGISTRY_PROGRAM_ID = "regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ";
/** Default pool tree (from Helius docs). UNVERIFIED: the SDK derives it from treeId; read client.tree at runtime. */
export const DEFAULT_TREE_ADDRESS = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** SPR uses the System program address as the SOL "mint". */
export const SOL_MINT_ADDRESS = "11111111111111111111111111111111";

/**
 * Privacy Program instruction tags (first data byte).
 * Verified against @heliuslabs/spr@0.9.0-alpha dist/interface/program.js `InstructionTag`.
 */
export const PrivacyIx = {
  deposit: 15,
  transact: 16,
  mergeTransact: 17,
} as const;

/** Registry `register` puts the payer at account index 2 (owner at 1). Verified in dist/wallet/registry.js. */
export const REGISTRY_PAYER_INDEX = 2;

/** Sponsor safety limits (relayer pays these). */
export const SPONSOR_LIMITS = {
  /** Total priority fee the relayer will pay per tx. */
  maxPriorityFeeLamports: 200_000n,
  /** Each signature costs the fee payer 5000 lamports base fee. */
  maxSignatures: 4,
  /** Max size of a v1 tx is 4096 bytes. */
  maxTxBytes: 4096,
} as const;

export type RingsNetwork = "devnet" | "mainnet";

/**
 * Indexer (Photon) and prover endpoints from the SDK README (0.9.0-alpha).
 * UNVERIFIED live: we had no Helius API key while building this.
 */
export const SPR_ENDPOINTS: Record<RingsNetwork, { indexerUrl: string; proverUrl: string }> = {
  devnet: {
    indexerUrl: "https://d34xe1hqb2ibg2.cloudfront.net",
    proverUrl: "https://dd73hh473h6ha.cloudfront.net",
  },
  mainnet: {
    indexerUrl: "https://dgcj4pjarvo65.cloudfront.net",
    proverUrl: "https://d3ky2kt0ntqxt1.cloudfront.net",
  },
};

export function heliusRpcUrl(network: RingsNetwork, apiKey: string): string {
  return `https://${network}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

/** Message a user's wallet signs to derive their Pispt Rings key (see client.ts). */
export const RINGS_DERIVE_MESSAGE = (walletBase58: string) => "Pispt rings key v1\n" + walletBase58;
