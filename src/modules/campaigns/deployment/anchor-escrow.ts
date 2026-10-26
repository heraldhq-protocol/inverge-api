import { createHash } from 'node:crypto';
import { campaignIdBytes } from './campaign-terms';

/**
 * The Inverge escrow programme's `create_campaign` instruction and `Campaign`
 * account, encoded and decoded from the Rust source in `inverge-escrow`.
 *
 * Source of truth:
 *   programs/inverge_escrow/src/lib.rs             (argument order)
 *   programs/inverge_escrow/src/instructions/create_campaign.rs (accounts, layout)
 *   programs/inverge_escrow/src/state.rs           (Campaign fields)
 *
 * Assumption to confirm with the contract developer: the repository contains no
 * committed IDL artefact and no evidence that the deployed bytecode matches this
 * source. `docs/campaign-deployment.md` records this as an open blocker; the
 * decoder here is the only thing standing between a mismatched layout and a
 * wrongly confirmed deployment.
 */

export const ESCROW_PROGRAM_ID = '38rarxmrSL3rjCN2bwdDfQNLtpYRgLGp96xfkPXv39S1';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Anchor discriminators are the first 8 bytes of sha256("<namespace>:<name>"). */
export function anchorDiscriminator(namespace: 'global' | 'account', name: string): Uint8Array {
  return createHash('sha256').update(`${namespace}:${name}`, 'utf8').digest().subarray(0, 8);
}

export const CREATE_CAMPAIGN_DISCRIMINATOR = anchorDiscriminator('global', 'create_campaign');
export const CAMPAIGN_ACCOUNT_DISCRIMINATOR = anchorDiscriminator('account', 'Campaign');
export const PLATFORM_CONFIG_DISCRIMINATOR = anchorDiscriminator('account', 'PlatformConfig');

/** PDA seed bytes, matching `constants.rs`. */
export const CONFIG_SEED = Buffer.from('platform_config', 'utf8');
export const CAMPAIGN_SEED = Buffer.from('campaign', 'utf8');
export const ESCROW_VAULT_SEED = Buffer.from('escrow_vault', 'utf8');

export const MAX_MILESTONES = 6;
export const MIN_MILESTONES = 2;
export const TOTAL_BPS = 10_000;
export const WORKING_CAPITAL_BPS = 2_000;
export const DEFAULT_FEE_BPS = 500;

/** Anchor account discriminator (8) + `Campaign::INIT_SPACE`. */
export const CAMPAIGN_ACCOUNT_SIZE = 867;
/** A classic SPL token account; the vault is initialised as one. */
export const TOKEN_ACCOUNT_SIZE = 165;
/** A classic SPL mint account. */
export const MINT_ACCOUNT_SIZE = 82;
/** `decimals` sits at byte 44 in the SPL mint layout (after COption + supply). */
export const MINT_DECIMALS_OFFSET = 44;

/**
 * Reads `decimals` from a serialised SPL mint. Returns `null` when the account is
 * not a mint this programme can settle in, so a caller never scales money with a
 * guessed exponent.
 */
export function decodeMintDecimals(data: Uint8Array): number | null {
  const buffer = Buffer.from(data);
  if (buffer.length < MINT_ACCOUNT_SIZE) return null;
  const isInitialized = buffer.readUInt8(45);
  if (isInitialized !== 1) return null;
  return buffer.readUInt8(MINT_DECIMALS_OFFSET);
}

export interface AnchorMilestoneInput {
  trancheBps: number;
  evidenceHash: string; // hex, 32 bytes
  deadline: number; // unix seconds
}

export interface CreateCampaignArgs {
  campaignId: Uint8Array; // 32 bytes
  targetAmount: bigint;
  floorAmount: bigint;
  deadline: number; // unix seconds
  termsHash: string; // hex, 32 bytes
  workingCapitalBps: number;
  customFeeBps: number | null;
  milestones: readonly AnchorMilestoneInput[];
}

class Writer {
  private readonly chunks: Buffer[] = [];

  bytes(value: Uint8Array): void {
    this.chunks.push(Buffer.from(value));
  }

  u8(value: number): void {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value);
    this.chunks.push(buffer);
  }

  u16(value: number): void {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    this.chunks.push(buffer);
  }

  u32(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0);
    this.chunks.push(buffer);
  }

  u64(value: bigint): void {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    this.chunks.push(buffer);
  }

  i64(value: number): void {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(BigInt(value));
    this.chunks.push(buffer);
  }

  finish(): Uint8Array {
    return Buffer.concat(this.chunks);
  }
}

function parseHex32(value: string, field: string): Uint8Array {
  const normalised = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error(`${field} must be 32 bytes of hex`);
  }
  return Buffer.from(normalised, 'hex');
}

/**
 * Borsh encoding of `create_campaign`'s arguments:
 *   [u8;32], u64, u64, i64, [u8;32], u16, Option<u16>, Vec<MilestoneInput>
 * prefixed with the Anchor `global:create_campaign` discriminator.
 *
 * Integers are validated here rather than trusted from the DTO so an
 * out-of-range value can never be encoded as a different number by truncation.
 */
export function encodeCreateCampaignInstruction(args: CreateCampaignArgs): Uint8Array {
  if (args.campaignId.length !== 32) throw new Error('campaignId must be 32 bytes');
  if (!Number.isInteger(args.workingCapitalBps) || args.workingCapitalBps < 0 || args.workingCapitalBps > 0xffff) {
    throw new Error('workingCapitalBps is out of range');
  }
  if (args.customFeeBps !== null && (!Number.isInteger(args.customFeeBps) || args.customFeeBps < 0 || args.customFeeBps > 0xffff)) {
    throw new Error('customFeeBps is out of range');
  }
  if (args.milestones.length < MIN_MILESTONES || args.milestones.length > MAX_MILESTONES) {
    throw new Error(`A campaign needs ${MIN_MILESTONES}–${MAX_MILESTONES} milestones`);
  }
  if (!Number.isInteger(args.deadline) || args.deadline <= 0) {
    throw new Error('deadline must be a positive unix timestamp');
  }
  if (args.targetAmount <= 0n) throw new Error('targetAmount must be positive');

  const writer = new Writer();
  writer.bytes(CREATE_CAMPAIGN_DISCRIMINATOR);
  writer.bytes(args.campaignId);
  writer.u64(args.targetAmount);
  writer.u64(args.floorAmount);
  writer.i64(args.deadline);
  writer.bytes(parseHex32(args.termsHash, 'termsHash'));
  writer.u16(args.workingCapitalBps);

  if (args.customFeeBps === null) {
    writer.u8(0);
  } else {
    writer.u8(1);
    writer.u16(args.customFeeBps);
  }

  writer.u32(args.milestones.length);
  for (const milestone of args.milestones) {
    if (!Number.isInteger(milestone.trancheBps) || milestone.trancheBps < 0 || milestone.trancheBps > 0xffff) {
      throw new Error('milestone trancheBps is out of range');
    }
    if (!Number.isInteger(milestone.deadline) || milestone.deadline <= 0) {
      throw new Error('milestone deadline must be a positive unix timestamp');
    }
    writer.u16(milestone.trancheBps);
    writer.bytes(parseHex32(milestone.evidenceHash, 'milestone evidenceHash'));
    writer.i64(milestone.deadline);
  }

  return writer.finish();
}

export interface DecodedCampaignMilestone {
  trancheBps: number;
  evidenceHash: string;
  proofBundleHash: string;
  status: number;
  deadline: number;
  claimTimestamp: number;
  objectionWindowEnd: number;
  appealWindowEnd: number;
  objectionCapital: bigint;
}

export interface DecodedCampaign {
  campaignId: string;
  creator: string;
  tokenMint: string;
  escrowVault: string;
  targetAmount: bigint;
  floorAmount: bigint;
  deadline: number;
  termsHash: string;
  state: number;
  totalRaised: bigint;
  totalReleased: bigint;
  totalRefunded: bigint;
  workingCapitalBps: number;
  feeBps: number;
  currentMilestoneIndex: number;
  milestoneCount: number;
  milestones: DecodedCampaignMilestone[];
  bump: number;
  vaultBump: number;
}

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  private take(length: number): Buffer {
    if (this.offset + length > this.data.length) {
      throw new Error('Campaign account data is truncated');
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  bytes(length: number): Buffer {
    return this.take(length);
  }

  u8(): number {
    return this.take(1).readUInt8(0);
  }

  u16(): number {
    return this.take(2).readUInt16LE(0);
  }

  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  i64(): number {
    const value = this.take(8).readBigInt64LE(0);
    // Timestamps fit comfortably in a JS number; this only guards corruption.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('Campaign timestamp is out of safe integer range');
    }
    return Number(value);
  }

  hex(length: number): string {
    return this.take(length).toString('hex');
  }
}

/**
 * Decodes a serialised `Campaign` account. Returns `null` when the account is
 * not a Campaign at all, so a caller can distinguish "wrong account" from
 * "malformed Campaign".
 */
export function decodeCampaignAccount(data: Uint8Array): DecodedCampaign | null {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) return null;
  if (!buffer.subarray(0, 8).equals(Buffer.from(CAMPAIGN_ACCOUNT_DISCRIMINATOR))) {
    return null;
  }

  const reader = new Reader(buffer.subarray(8));
  const campaignId = reader.hex(32);
  const creator = reader.hex(32);
  const tokenMint = reader.hex(32);
  const escrowVault = reader.hex(32);
  const targetAmount = reader.u64();
  const floorAmount = reader.u64();
  const deadline = reader.i64();
  const termsHash = reader.hex(32);
  const state = reader.u8();
  const totalRaised = reader.u64();
  const totalReleased = reader.u64();
  const totalRefunded = reader.u64();
  const workingCapitalBps = reader.u16();
  const feeBps = reader.u16();
  const currentMilestoneIndex = reader.u8();
  const milestoneCount = reader.u8();

  const milestones: DecodedCampaignMilestone[] = [];
  for (let index = 0; index < MAX_MILESTONES; index += 1) {
    const milestone: DecodedCampaignMilestone = {
      trancheBps: reader.u16(),
      evidenceHash: reader.hex(32),
      proofBundleHash: reader.hex(32),
      status: reader.u8(),
      deadline: reader.i64(),
      claimTimestamp: reader.i64(),
      objectionWindowEnd: reader.i64(),
      appealWindowEnd: reader.i64(),
      objectionCapital: reader.u64(),
    };
    if (index < milestoneCount) milestones.push(milestone);
  }

  const bump = reader.u8();
  const vaultBump = reader.u8();

  return {
    bump,
    campaignId,
    creator,
    currentMilestoneIndex,
    deadline,
    escrowVault,
    feeBps,
    floorAmount,
    milestoneCount,
    milestones,
    state,
    targetAmount,
    termsHash,
    tokenMint,
    totalRaised,
    totalRefunded,
    totalReleased,
    vaultBump,
    workingCapitalBps,
  };
}

export interface DecodedCreateCampaignInstruction {
  campaignId: string; // hex
  targetAmount: bigint;
  floorAmount: bigint;
  deadline: number;
  termsHash: string; // hex
  workingCapitalBps: number;
  customFeeBps: number | null;
  milestones: readonly { trancheBps: number; evidenceHash: string; deadline: number }[];
}

class InstructionReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  private take(length: number): Buffer {
    if (this.offset + length > this.data.length) {
      throw new Error('Instruction data is truncated');
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  bytes(length: number): Buffer {
    return this.take(length);
  }

  u8(): number {
    return this.take(1).readUInt8(0);
  }

  u16(): number {
    return this.take(2).readUInt16LE(0);
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  i64(): number {
    return Number(this.take(8).readBigInt64LE(0));
  }
}

/**
 * Decodes `create_campaign` instruction data. Used at verification time to prove
 * that the transaction the creator signed carries *our* campaign values, rather
 * than merely touching the right programme.
 *
 * Returns `null` when the data is not this instruction.
 */
export function decodeCreateCampaignInstruction(
  data: Uint8Array,
): DecodedCreateCampaignInstruction | null {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) return null;
  if (!buffer.subarray(0, 8).equals(Buffer.from(CREATE_CAMPAIGN_DISCRIMINATOR))) {
    return null;
  }

  const reader = new InstructionReader(buffer.subarray(8));
  const campaignId = reader.bytes(32).toString('hex');
  const targetAmount = reader.u64();
  const floorAmount = reader.u64();
  const deadline = reader.i64();
  const termsHash = reader.bytes(32).toString('hex');
  const workingCapitalBps = reader.u16();
  const hasCustomFee = reader.u8();
  const customFeeBps = hasCustomFee === 1 ? reader.u16() : null;

  const count = reader.u32();
  if (count > MAX_MILESTONES) {
    throw new Error(`Instruction declares ${count} milestones, above the programme maximum`);
  }

  const milestones: { trancheBps: number; evidenceHash: string; deadline: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    // Field order mirrors `MilestoneInput` in create_campaign.rs, not the
    // (differently ordered) on-chain `Milestone` struct.
    const trancheBps = reader.u16();
    const evidenceHash = reader.bytes(32).toString('hex');
    const deadline = reader.i64();
    milestones.push({ deadline, evidenceHash, trancheBps });
  }

  return {
    campaignId,
    customFeeBps,
    deadline,
    floorAmount,
    milestones,
    targetAmount,
    termsHash,
    workingCapitalBps,
  };
}

/** The canonical account metas of `create_campaign`, in declaration order. */
export interface EscrowAccountMeta {
  name: 'config' | 'campaign' | 'tokenMint' | 'escrowVault' | 'creator' | 'systemProgram' | 'tokenProgram';
  writable: boolean;
  signer: boolean;
}

export const CREATE_CAMPAIGN_ACCOUNTS: readonly EscrowAccountMeta[] = [
  { name: 'config', signer: false, writable: false },
  { name: 'campaign', signer: false, writable: true },
  { name: 'tokenMint', signer: false, writable: false },
  { name: 'escrowVault', signer: false, writable: true },
  { name: 'creator', signer: true, writable: true },
  { name: 'systemProgram', signer: false, writable: false },
  { name: 'tokenProgram', signer: false, writable: false },
];

/** Seeds the browser needs to derive each PDA before building the instruction. */
export function pdaSeeds(campaignId: string): {
  config: string[];
  campaign: string[];
  escrowVault: (campaignPda: string) => string[];
} {
  const idBytes = campaignIdBytes(campaignId);
  return {
    campaign: [CAMPAIGN_SEED.toString('utf8'), Buffer.from(idBytes).toString('hex')],
    config: [CONFIG_SEED.toString('utf8')],
    escrowVault: (campaignPda: string) => [ESCROW_VAULT_SEED.toString('utf8'), campaignPda],
  };
}
