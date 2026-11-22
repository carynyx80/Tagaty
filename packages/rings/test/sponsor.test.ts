// Offline tests for the relayer fee-sponsorship validator. No network.
import { describe, expect, it, beforeAll } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  partiallySignTransactionWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { buildDepositTransaction, buildRegistrationTransaction, initializePoseidon, ShieldedKeypair } from "@heliuslabs/spr";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  PRIVACY_PROGRAM_ID,
  PrivacyIx,
  REGISTRY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SponsorRejectedError,
  validateSponsorableTx,
  verifyUserSignatures,
} from "../src/index.js";

const LIFETIME = { blockhash: blockhash("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"), lastValidBlockHeight: 1000n };
const TREE = address("777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor");

let relayer: KeyPairSigner;
let user: KeyPairSigner;
let other: KeyPairSigner;

beforeAll(async () => {
  relayer = await generateKeyPairSigner();
  user = await generateKeyPairSigner();
  other = await generateKeyPairSigner();
});

function cuLimit(units: number): Instruction {
  const d = new Uint8Array(5);
  d[0] = 2;
  new DataView(d.buffer).setUint32(1, units, true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ID), data: d };
}
function cuPrice(microLamports: bigint): Instruction {
  const d = new Uint8Array(9);
  d[0] = 3;
  new DataView(d.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ID), data: d };
}
function systemTransfer(from: Address, to: Address, lamports: bigint): Instruction {
  const d = new Uint8Array(12);
  new DataView(d.buffer).setUint32(0, 2, true); // Transfer
  new DataView(d.buffer).setBigUint64(4, lamports, true);
  return {
    programAddress: address(SYSTEM_PROGRAM_ID),
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data: d,
  };
}
/** Shape of the SDK's transactInstruction: payer(0), outputTree, program, system, inputTree, ..., owner signer. */
function privacyTransact(payer: Address, owner: Address): Instruction {
  return {
    programAddress: address(PRIVACY_PROGRAM_ID),
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: TREE, role: AccountRole.WRITABLE },
      { address: address(PRIVACY_PROGRAM_ID), role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM_ID), role: AccountRole.READONLY },
      { address: TREE, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([PrivacyIx.transact, 1, 2, 3, 4]),
  };
}
/** Shape of the SDK's depositInstruction: tree(0), depositor(1, writable signer), program, system, solInterface. */
function privacyDeposit(depositor: Address): Instruction {
  return {
    programAddress: address(PRIVACY_PROGRAM_ID),
    accounts: [
      { address: TREE, role: AccountRole.WRITABLE },
      { address: depositor, role: AccountRole.WRITABLE_SIGNER },
      { address: address(PRIVACY_PROGRAM_ID), role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM_ID), role: AccountRole.READONLY },
    ],
    data: new Uint8Array([PrivacyIx.deposit, 9, 9]),
  };
}

async function buildTx(opts: {
  feePayer: Address;
  instructions: Instruction[];
  version?: 0 | 1 | "legacy";
  priorityFeeLamports?: bigint;
  signers?: KeyPairSigner[];
}): Promise<Uint8Array> {
  const version = opts.version ?? 0;
  let msg: any = pipe(
    createTransactionMessage({ version } as { version: 0 }),
    (m) => setTransactionMessageFeePayer(opts.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
  );
  if (version === 1) {
    msg = setTransactionMessageConfig(
      {
        computeUnitLimit: 1_000_000,
        loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
        ...(opts.priorityFeeLamports !== undefined ? { priorityFeeLamports: opts.priorityFeeLamports } : {}),
      },
      msg,
    );
  }
  msg = appendTransactionMessageInstructions(opts.instructions, msg);
  let tx: Transaction = compileTransaction(msg);
  if (opts.signers?.length) tx = await partiallySignTransactionWithSigners(opts.signers, tx);
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

function expectReject(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SponsorRejectedError);
    expect((e as SponsorRejectedError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}`);
}

describe("validateSponsorableTx", () => {
  it("accepts privacy-program + compute-budget instructions with the relayer as fee payer (v0)", async () => {
    const bytes = await buildTx({
      feePayer: relayer.address,
      instructions: [cuLimit(400_000), cuPrice(1_000n), privacyTransact(relayer.address, user.address)],
      signers: [user],
    });
    const v = validateSponsorableTx(bytes, { relayer: relayer.address });
    expect(v.feePayer).toBe(relayer.address);
    expect(v.programs).toEqual([COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, PRIVACY_PROGRAM_ID]);
    expect(v.priorityFeeLamports).toBe(400n); // 1000 µlamports * 400k CU
    await expect(verifyUserSignatures(v.transaction, relayer.address)).resolves.toBeUndefined();
  });

  it("accepts the same in a legacy transaction", async () => {
    const bytes = await buildTx({
      version: "legacy",
      feePayer: relayer.address,
      instructions: [cuLimit(400_000), privacyTransact(relayer.address, user.address)],
      signers: [user],
    });
    expect(validateSponsorableTx(bytes, { relayer: relayer.address }).version).toBe("legacy");
  });

  it("accepts a version-1 transaction (the format the SPR SDK builds) with a small priority fee", async () => {
    const bytes = await buildTx({
      version: 1,
      feePayer: relayer.address,
      instructions: [privacyTransact(relayer.address, user.address)],
      priorityFeeLamports: 5_000n,
      signers: [user],
    });
    const v = validateSponsorableTx(bytes, { relayer: relayer.address });
    expect(v.version).toBe(1);
    expect(v.priorityFeeLamports).toBe(5_000n);
  });

  it("rejects a System transfer from the relayer", async () => {
    const bytes = await buildTx({
      feePayer: relayer.address,
      instructions: [privacyTransact(relayer.address, user.address), systemTransfer(relayer.address, user.address, 1_000_000_000n)],
      signers: [user],
    });
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "relayer_debit");
  });

  it("rejects the wrong fee payer", async () => {
    const bytes = await buildTx({
      feePayer: user.address,
      instructions: [privacyTransact(user.address, user.address)],
    });
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "fee_payer");
  });

  it("rejects an unknown program", async () => {
    const bytes = await buildTx({
      feePayer: relayer.address,
      instructions: [
        privacyTransact(relayer.address, user.address),
        { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: new Uint8Array([104, 105]) },
      ],
    });
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "program");
  });

  it("rejects a Rings deposit funded by the relayer", async () => {
    const bytes = await buildTx({ feePayer: relayer.address, instructions: [privacyDeposit(relayer.address)] });
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "relayer_debit");
  });

  it("rejects the relayer in a non-payer slot of a transact (e.g. as owner)", async () => {
    const bytes = await buildTx({ feePayer: relayer.address, instructions: [privacyTransact(user.address, relayer.address)] });
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "relayer_debit");
  });

  it("rejects non-sponsorable Privacy Program instructions", async () => {
    const ix = privacyTransact(relayer.address, user.address);
    const bytes = await buildTx({
      feePayer: relayer.address,
      instructions: [{ ...ix, data: new Uint8Array([5 /* claimTreeLamports */]) }],
    });
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "privacy_ix");
  });

  it("rejects an excessive priority fee (compute-unit price and v1 config)", async () => {
    const a = await buildTx({
      feePayer: relayer.address,
      instructions: [cuLimit(1_400_000), cuPrice(10_000_000n), privacyTransact(relayer.address, user.address)],
    });
    expectReject(() => validateSponsorableTx(a, { relayer: relayer.address }), "priority_fee");
    const b = await buildTx({
      version: 1,
      feePayer: relayer.address,
      instructions: [privacyTransact(relayer.address, user.address)],
      priorityFeeLamports: 10_000_000n,
    });
    expectReject(() => validateSponsorableTx(b, { relayer: relayer.address }), "priority_fee");
  });

  it("allows a System instruction that does not involve the relayer", async () => {
    const bytes = await buildTx({
      feePayer: relayer.address,
      instructions: [systemTransfer(user.address, other.address, 1n), privacyTransact(relayer.address, user.address)],
      signers: [user],
    });
    expect(() => validateSponsorableTx(bytes, { relayer: relayer.address })).not.toThrow();
  });

  it("rejects garbage bytes", () => {
    expectReject(() => validateSponsorableTx(new Uint8Array([1, 2, 3]), { relayer: relayer.address }), "decode");
  });

  it("detects a missing / forged user signature", async () => {
    const unsigned = await buildTx({ feePayer: relayer.address, instructions: [privacyTransact(relayer.address, user.address)] });
    const v = validateSponsorableTx(unsigned, { relayer: relayer.address });
    await expect(verifyUserSignatures(v.transaction, relayer.address)).rejects.toMatchObject({ code: "missing_signature" });
    const forged = { ...v.transaction, signatures: { ...v.transaction.signatures, [user.address]: new Uint8Array(64).fill(7) } };
    await expect(verifyUserSignatures(forged as Transaction, relayer.address)).rejects.toMatchObject({ code: "bad_signature" });
  });
});

// Real SDK builders with a mocked chain client: proves our rules accept what @heliuslabs/spr emits.
describe("SDK-built transactions (offline, mocked client)", () => {
  beforeAll(async () => {
    await initializePoseidon();
  });
  const mockClient = () => ({
    tree: TREE,
    treeId: 0,
    getLatestBlockhash: async () => LIFETIME,
    getAccount: async () => undefined,
  });

  it("a sponsored SOL deposit (depositor = user, feePayer = relayer) passes", async () => {
    const kp = ShieldedKeypair.generate();
    const tx = await buildDepositTransaction({
      client: mockClient() as any,
      feePayer: relayer.address,
      depositor: user.address,
      recipient: kp.shieldedAddress(),
      amount: 1_000_000n,
    });
    const bytes = new Uint8Array(getTransactionEncoder().encode(tx));
    const v = validateSponsorableTx(bytes, { relayer: relayer.address });
    expect(v.version).toBe(1);
    expect(v.programs).toEqual([PRIVACY_PROGRAM_ID]);
  });

  it("an SDK deposit that defaults depositor to the relayer is rejected", async () => {
    const kp = ShieldedKeypair.generate();
    const tx = await buildDepositTransaction({
      client: mockClient() as any,
      feePayer: relayer.address,
      recipient: kp.shieldedAddress(),
      amount: 1_000_000n,
    });
    const bytes = new Uint8Array(getTransactionEncoder().encode(tx));
    expectReject(() => validateSponsorableTx(bytes, { relayer: relayer.address }), "relayer_debit");
  });

  it("a sponsored registry registration (payer = relayer) passes", async () => {
    const kp = ShieldedKeypair.generate();
    const owner = kp.toSolanaSigner();
    const tx = await buildRegistrationTransaction({
      client: mockClient() as any,
      owner: owner.address,
      address: kp.shieldedAddress(),
      payer: relayer.address,
    });
    expect(tx).toBeDefined();
    const bytes = new Uint8Array(getTransactionEncoder().encode(tx!));
    const v = validateSponsorableTx(bytes, { relayer: relayer.address });
    expect(v.programs).toEqual([REGISTRY_PROGRAM_ID]);
  });
});
