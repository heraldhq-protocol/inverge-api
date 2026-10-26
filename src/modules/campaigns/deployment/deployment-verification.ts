import { base58ToBytes } from '../../../common/utils/base58.util';
import {
  TOKEN_PROGRAM_ID,
  decodeCampaignAccount,
  decodeCreateCampaignInstruction,
} from './anchor-escrow';
import type { ChainAccount, ChainTransaction } from '../../../ports/escrow/escrow-chain.port';

/**
 * Server-side verification of a submitted deployment transaction.
 *
 * This is the only place that decides a deployment is real. The browser's
 * success callback, a signature string, and an HTTP 200 are all insufficient:
 * the transaction must have executed, it must carry *this* campaign's values,
 * and the resulting accounts must match the database record.
 *
 * Pure so every branch is unit-testable with recorded RPC payloads.
 */

export interface ExpectedDeployment {
  campaignIdHex: string;
  creatorWallet: string;
  tokenMint: string;
  targetAmount: bigint;
  floorAmount: bigint;
  deadline: number;
  termsHash: string;
  workingCapitalBps: number;
  programId: string;
  milestones: readonly { trancheBps: number; evidenceHash: string; deadline: number }[];
}

export type VerificationVerdict = 'confirmed' | 'pending' | 'failed' | 'needs_reconciliation';

export interface VerificationResult {
  verdict: VerificationVerdict;
  code: string;
  message: string;
  campaignPda: string | null;
  escrowVault: string | null;
  slot: number | null;
  blockTime: Date | null;
  onChain: {
    campaignIdHex: string;
    creator: string;
    tokenMint: string;
    targetAmount: string;
    termsHash: string;
    milestoneCount: number;
  } | null;
}

/** Decodes a classic SPL token account (165 bytes). */
export function decodeTokenAccount(
  data: Uint8Array,
): { mint: string; owner: string; amount: bigint } | null {
  const buffer = Buffer.from(data);
  if (buffer.length < 165) return null;
  return {
    amount: buffer.readBigUInt64LE(64),
    mint: buffer.subarray(0, 32).toString('hex'),
    owner: buffer.subarray(32, 64).toString('hex'),
  };
}

function accountData(account: ChainAccount): Uint8Array | null {
  if (!account.exists || !account.dataBase64) return null;
  return Buffer.from(account.dataBase64, 'base64');
}

/**
 * Locates the `create_campaign` instruction in a transaction and returns the
 * accounts the programme initialised. Used to know *which* account to fetch
 * before verification; the fetched state is still verified independently.
 */
export function extractCreateCampaignAccounts(
  transaction: ChainTransaction,
  programId: string,
): { campaignPda: string; escrowVault: string; signer: string } | null {
  for (const instruction of transaction.instructions) {
    if (instruction.programId !== programId) continue;

    let data: Uint8Array;
    try {
      data = Buffer.from(instruction.dataBase64, 'base64');
    } catch {
      continue;
    }

    if (!decodeCreateCampaignInstruction(data)) continue;

    const campaignPda = instruction.accounts[1];
    const escrowVault = instruction.accounts[3];
    const signer = instruction.accounts[4];
    if (!campaignPda || !escrowVault || !signer) return null;

    return { campaignPda, escrowVault, signer };
  }

  return null;
}

export function verifyDeployment(input: {
  expected: ExpectedDeployment;
  transaction: ChainTransaction;
  campaignAccount: ChainAccount;
  vaultAccount: ChainAccount;
}): VerificationResult {
  const { expected, transaction, campaignAccount, vaultAccount } = input;

  const base: Omit<VerificationResult, 'verdict' | 'code' | 'message'> = {
    blockTime: transaction.blockTime === null ? null : new Date(transaction.blockTime * 1000),
    campaignPda: null,
    escrowVault: null,
    onChain: null,
    slot: transaction.slot,
  };

  if (!transaction.found) {
    return {
      ...base,
      code: 'TRANSACTION_NOT_FOUND',
      message: 'The cluster has not seen this transaction yet.',
      verdict: 'pending',
    };
  }

  if (!transaction.success) {
    return {
      ...base,
      code: 'ON_CHAIN_EXECUTION_FAILED',
      message: `The transaction executed with an error: ${transaction.error ?? 'unknown'}.`,
      verdict: 'failed',
    };
  }

  // Find our instruction and decode its arguments. The signature only proves the
  // creator authorised *some* transaction; this proves which one.
  let matching: {
    args: NonNullable<ReturnType<typeof decodeCreateCampaignInstruction>>;
    instruction: ChainTransaction['instructions'][number];
  } | null = null;

  for (const instruction of transaction.instructions) {
    if (instruction.programId !== expected.programId) continue;

    let data: Uint8Array;
    try {
      data = Buffer.from(instruction.dataBase64, 'base64');
    } catch {
      continue;
    }

    const args = decodeCreateCampaignInstruction(data);
    if (args) {
      matching = { args, instruction };
      break;
    }
  }

  if (!matching) {
    return {
      ...base,
      code: 'EXPECTED_INSTRUCTION_MISSING',
      message: 'The transaction does not contain a create_campaign instruction for the configured programme.',
      verdict: 'needs_reconciliation',
    };
  }

  const { args, instruction } = matching;

  const expectedMilestones = expected.milestones.map((milestone) => ({
    deadline: milestone.deadline,
    evidenceHash: milestone.evidenceHash,
    trancheBps: milestone.trancheBps,
  }));
  const argsMilestones = args.milestones.map((milestone) => ({
    deadline: milestone.deadline,
    evidenceHash: milestone.evidenceHash,
    trancheBps: milestone.trancheBps,
  }));

  if (
    args.campaignId !== expected.campaignIdHex ||
    args.targetAmount !== expected.targetAmount ||
    args.floorAmount !== expected.floorAmount ||
    args.deadline !== expected.deadline ||
    args.termsHash !== expected.termsHash ||
    args.workingCapitalBps !== expected.workingCapitalBps ||
    JSON.stringify(argsMilestones) !== JSON.stringify(expectedMilestones)
  ) {
    return {
      ...base,
      code: 'TRANSACTION_DOES_NOT_MATCH_CAMPAIGN',
      message: 'The transaction is for different campaign terms than this draft.',
      verdict: 'failed',
    };
  }

  const campaignPda = instruction.accounts[1] ?? null;
  const escrowVault = instruction.accounts[3] ?? null;
  const signer = instruction.accounts[4] ?? null;

  if (!campaignPda || !escrowVault || !signer) {
    return {
      ...base,
      code: 'EXPECTED_ACCOUNTS_MISSING',
      message: 'The instruction does not carry the expected campaign, vault and creator accounts.',
      verdict: 'needs_reconciliation',
    };
  }

  if (signer !== expected.creatorWallet) {
    return {
      ...base,
      campaignPda,
      code: 'CREATOR_MISMATCH',
      escrowVault,
      message: 'The transaction was not signed by the wallet linked to this campaign.',
      verdict: 'failed',
    };
  }

  if (!campaignAccount.exists) {
    return {
      ...base,
      campaignPda,
      code: 'CAMPAIGN_ACCOUNT_NOT_VISIBLE',
      escrowVault,
      message: 'The campaign account is not visible at the configured commitment yet.',
      verdict: 'pending',
    };
  }

  if (campaignAccount.owner !== expected.programId) {
    return {
      ...base,
      campaignPda,
      code: 'CAMPAIGN_ACCOUNT_WRONG_OWNER',
      escrowVault,
      message: 'The campaign address is not owned by the configured escrow programme.',
      verdict: 'failed',
    };
  }

  const data = accountData(campaignAccount);
  const decoded = data ? decodeCampaignAccount(data) : null;
  if (!decoded) {
    return {
      ...base,
      campaignPda,
      code: 'CAMPAIGN_ACCOUNT_UNDECODABLE',
      escrowVault,
      message: 'The programme account does not match the expected Campaign layout.',
      verdict: 'needs_reconciliation',
    };
  }

  const onChain = {
    campaignIdHex: decoded.campaignId,
    creator: decoded.creator,
    milestoneCount: decoded.milestoneCount,
    targetAmount: decoded.targetAmount.toString(),
    termsHash: decoded.termsHash,
    tokenMint: decoded.tokenMint,
  };

  const milestoneMismatch =
    decoded.milestoneCount !== expectedMilestones.length ||
    decoded.milestones.some((milestone, index) => {
      const expectedMilestone = expectedMilestones[index];
      if (!expectedMilestone) return true;
      return (
        milestone.trancheBps !== expectedMilestone.trancheBps ||
        milestone.evidenceHash !== expectedMilestone.evidenceHash ||
        milestone.deadline !== expectedMilestone.deadline
      );
    });

  const creatorHex = Buffer.from(base58ToBytes(expected.creatorWallet)).toString('hex');

  if (
    decoded.campaignId !== expected.campaignIdHex ||
    decoded.creator !== creatorHex ||
    decoded.tokenMint !== Buffer.from(base58ToBytes(expected.tokenMint)).toString('hex') ||
    decoded.targetAmount !== expected.targetAmount ||
    decoded.floorAmount !== expected.floorAmount ||
    decoded.deadline !== expected.deadline ||
    decoded.termsHash !== expected.termsHash ||
    decoded.workingCapitalBps !== expected.workingCapitalBps ||
    milestoneMismatch
  ) {
    return {
      ...base,
      campaignPda,
      code: 'ON_CHAIN_STATE_MISMATCH',
      escrowVault,
      message: 'The on-chain campaign does not match the terms this draft committed to.',
      onChain,
      verdict: 'failed',
    };
  }

  if (!vaultAccount.exists) {
    return {
      ...base,
      campaignPda,
      code: 'VAULT_ACCOUNT_NOT_VISIBLE',
      escrowVault,
      message: 'The escrow vault is not visible at the configured commitment yet.',
      onChain,
      verdict: 'pending',
    };
  }

  if (vaultAccount.owner !== TOKEN_PROGRAM_ID) {
    return {
      ...base,
      campaignPda,
      code: 'VAULT_WRONG_OWNER',
      escrowVault,
      message: 'The escrow vault is not an SPL token account.',
      onChain,
      verdict: 'failed',
    };
  }

  const vaultData = accountData(vaultAccount);
  const vault = vaultData ? decodeTokenAccount(vaultData) : null;
  if (!vault) {
    return {
      ...base,
      campaignPda,
      code: 'VAULT_UNDECODABLE',
      escrowVault,
      message: 'The escrow vault account could not be decoded.',
      onChain,
      verdict: 'needs_reconciliation',
    };
  }

  const expectedMintHex = Buffer.from(base58ToBytes(expected.tokenMint)).toString('hex');
  const expectedVaultOwner = Buffer.from(base58ToBytes(escrowVault)).toString('hex');
  if (vault.mint !== expectedMintHex || vault.owner !== expectedVaultOwner) {
    return {
      ...base,
      campaignPda,
      code: 'VAULT_MISMATCH',
      escrowVault,
      message: 'The escrow vault holds a different mint or is controlled by a different authority.',
      onChain,
      verdict: 'failed',
    };
  }

  return {
    ...base,
    campaignPda,
    code: 'DEPLOYMENT_CONFIRMED',
    escrowVault,
    message: 'The campaign and its escrow vault match the published terms on-chain.',
    onChain,
    verdict: 'confirmed',
  };
}
