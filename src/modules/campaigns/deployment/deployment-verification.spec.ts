import { base58ToBytes } from '../../../common/utils/base58.util';
import type { ChainAccount, ChainTransaction } from '../../../ports/escrow/escrow-chain.port';
import {
  CREATE_CAMPAIGN_ACCOUNTS,
  TOKEN_PROGRAM_ID,
  encodeCreateCampaignInstruction,
} from './anchor-escrow';
import {
  extractCreateCampaignAccounts,
  verifyDeployment,
  type ExpectedDeployment,
} from './deployment-verification';

const PROGRAM_ID = '38rarxmrSL3rjCN2bwdDfQNLtpYRgLGp96xfkPXv39S1';
const CREATOR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const CONFIG_PDA = 'So11111111111111111111111111111111111111112';
const CAMPAIGN_PDA = '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E';
const VAULT_PDA = '9xQeWvG816bUx9EPf2ZB6d9c3nd8kGKw9gCjALZfG7Ns';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const CAMPAIGN_ID_HEX = 'c'.repeat(64);
const TERMS_HASH = 'e'.repeat(64);
const EVIDENCE = 'd'.repeat(64);
const DEADLINE = 1_800_000_000;

function bytes(address: string): Buffer {
  return Buffer.from(base58ToBytes(address));
}

function expected(overrides: Partial<ExpectedDeployment> = {}): ExpectedDeployment {
  return {
    campaignIdHex: CAMPAIGN_ID_HEX,
    creatorWallet: CREATOR,
    deadline: DEADLINE,
    floorAmount: 5_000_000_000n,
    milestones: [
      { deadline: 1_800_100_000, evidenceHash: EVIDENCE, trancheBps: 5_000 },
      { deadline: 1_800_200_000, evidenceHash: EVIDENCE, trancheBps: 5_000 },
    ],
    programId: PROGRAM_ID,
    targetAmount: 5_000_000_000n,
    termsHash: TERMS_HASH,
    tokenMint: MINT,
    workingCapitalBps: 2_000,
    ...overrides,
  };
}

function instructionData(input = expected()): string {
  return Buffer.from(
    encodeCreateCampaignInstruction({
      campaignId: Buffer.from(input.campaignIdHex, 'hex'),
      customFeeBps: null,
      deadline: input.deadline,
      floorAmount: input.floorAmount,
      milestones: input.milestones,
      targetAmount: input.targetAmount,
      termsHash: input.termsHash,
      workingCapitalBps: input.workingCapitalBps,
    }),
  ).toString('base64');
}

function transaction(input = expected()): ChainTransaction {
  return {
    blockTime: 1_790_000_000,
    commitment: 'finalized',
    error: null,
    found: true,
    instructions: [
      {
        accounts: [
          CONFIG_PDA,
          CAMPAIGN_PDA,
          input.tokenMint,
          VAULT_PDA,
          input.creatorWallet,
          SYSTEM_PROGRAM,
          TOKEN_PROGRAM_ID,
        ],
        dataBase64: instructionData(input),
        programId: input.programId,
      },
    ],
    slot: 123,
    success: true,
  };
}

function campaignAccount(input = expected()): ChainAccount {
  const data = Buffer.alloc(867);
  Buffer.from('3228310b9ddce5c0', 'hex').copy(data, 0);
  let offset = 8;
  const write = (buffer: Buffer) => {
    buffer.copy(data, offset);
    offset += buffer.length;
  };
  const u8 = (value: number) => {
    data.writeUInt8(value, offset);
    offset += 1;
  };
  const u16 = (value: number) => {
    data.writeUInt16LE(value, offset);
    offset += 2;
  };
  const u64 = (value: bigint) => {
    data.writeBigUInt64LE(value, offset);
    offset += 8;
  };
  const i64 = (value: number) => {
    data.writeBigInt64LE(BigInt(value), offset);
    offset += 8;
  };

  write(Buffer.from(input.campaignIdHex, 'hex'));
  write(bytes(input.creatorWallet));
  write(bytes(input.tokenMint));
  write(bytes(VAULT_PDA));
  u64(input.targetAmount);
  u64(input.floorAmount);
  i64(input.deadline);
  write(Buffer.from(input.termsHash, 'hex'));
  u8(0);
  u64(0n);
  u64(0n);
  u64(0n);
  u16(input.workingCapitalBps);
  u16(500);
  u8(0);
  u8(input.milestones.length);
  for (let index = 0; index < 6; index += 1) {
    const milestone = input.milestones[index];
    u16(milestone?.trancheBps ?? 0);
    write(Buffer.from(milestone?.evidenceHash ?? '0'.repeat(64), 'hex'));
    write(Buffer.alloc(32, 0));
    u8(0);
    i64(milestone?.deadline ?? 0);
    i64(0);
    i64(0);
    i64(0);
    u64(0n);
  }
  u8(255);
  u8(254);

  return { dataBase64: data.toString('base64'), exists: true, lamports: 2_000_000n, owner: PROGRAM_ID };
}

function vaultAccount(input = expected()): ChainAccount {
  const data = Buffer.alloc(165);
  bytes(input.tokenMint).copy(data, 0);
  bytes(VAULT_PDA).copy(data, 32);
  data.writeBigUInt64LE(0n, 64);
  data.writeUInt8(1, 108);
  return { dataBase64: data.toString('base64'), exists: true, lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID };
}

function verify(overrides: {
  campaignAccount?: ChainAccount;
  expected?: ExpectedDeployment;
  transaction?: ChainTransaction;
  vaultAccount?: ChainAccount;
} = {}) {
  return verifyDeployment({
    campaignAccount: overrides.campaignAccount ?? campaignAccount(),
    expected: overrides.expected ?? expected(),
    transaction: overrides.transaction ?? transaction(),
    vaultAccount: overrides.vaultAccount ?? vaultAccount(),
  });
}

describe('extractCreateCampaignAccounts', () => {
  it('returns the campaign, vault and creator accounts in declaration order', () => {
    // #given a transaction carrying our programme's instruction
    // #when the accounts are extracted
    // #then the positional metas match create_campaign.rs
    expect(extractCreateCampaignAccounts(transaction(), PROGRAM_ID)).toEqual({
      campaignPda: CAMPAIGN_PDA,
      escrowVault: VAULT_PDA,
      signer: CREATOR,
    });
    expect(CREATE_CAMPAIGN_ACCOUNTS.map((meta) => meta.name)).toEqual([
      'config',
      'campaign',
      'tokenMint',
      'escrowVault',
      'creator',
      'systemProgram',
      'tokenProgram',
    ]);
  });

  it('ignores transactions that do not contain our instruction', () => {
    // #given a transaction from another programme
    const foreign = transaction();
    foreign.instructions[0]!.programId = SYSTEM_PROGRAM;

    // #when extracted
    // #then no accounts are reported
    expect(extractCreateCampaignAccounts(foreign, PROGRAM_ID)).toBeNull();
  });
});

describe('verifyDeployment', () => {
  it('confirms a transaction whose arguments and accounts all match', () => {
    // #given a successful transaction and matching chain state
    const result = verify();

    // #when verified
    // #then the verdict is confirmed and the observed state is recorded
    expect(result.verdict).toBe('confirmed');
    expect(result.code).toBe('DEPLOYMENT_CONFIRMED');
    expect(result.campaignPda).toBe(CAMPAIGN_PDA);
    expect(result.escrowVault).toBe(VAULT_PDA);
    expect(result.onChain?.campaignIdHex).toBe(CAMPAIGN_ID_HEX);
    expect(result.onChain?.milestoneCount).toBe(2);
    expect(result.blockTime).toEqual(new Date(1_790_000_000 * 1000));
  });

  it('waits when the cluster has not seen the transaction', () => {
    // #given an unknown signature
    const result = verify({ transaction: { ...transaction(), found: false } });

    // #when verified
    // #then it is pending, never failed
    expect(result.verdict).toBe('pending');
    expect(result.code).toBe('TRANSACTION_NOT_FOUND');
  });

  it('fails a transaction that executed with an error', () => {
    // #given an on-chain execution error
    const result = verify({
      transaction: { ...transaction(), error: 'InstructionError(0, Custom(6001))', success: false },
    });

    // #when verified
    // #then the attempt is failed with the programme error preserved
    expect(result.verdict).toBe('failed');
    expect(result.code).toBe('ON_CHAIN_EXECUTION_FAILED');
    expect(result.message).toContain('Custom(6001)');
  });

  it('rejects a transaction that does not carry create_campaign at all', () => {
    // #given a successful transaction from our programme with unrelated data
    const foreign = transaction();
    foreign.instructions[0]!.dataBase64 = Buffer.from('deadbeef', 'hex').toString('base64');

    // #when verified
    // #then it needs reconciliation rather than being trusted
    expect(verify({ transaction: foreign }).code).toBe('EXPECTED_INSTRUCTION_MISSING');
  });

  it('rejects a transaction built for different terms', () => {
    // #given a transaction whose target differs from the draft
    const tampered = transaction(expected({ targetAmount: 1_000_000_000n }));

    // #when verified
    // #then it is failed rather than accepted as "close enough"
    expect(verify({ transaction: tampered }).code).toBe('TRANSACTION_DOES_NOT_MATCH_CAMPAIGN');
  });

  it('rejects a transaction signed by a different wallet', () => {
    // #given a transaction whose creator account is not the linked wallet
    const other = expected({ creatorWallet: CONFIG_PDA });

    // #when verified
    // #then verification fails before reading state
    expect(verify({ expected: other, transaction: transaction() }).code).toBe(
      'CREATOR_MISMATCH',
    );
  });

  it('waits when the campaign account is not visible yet', () => {
    // #given a transaction that landed but whose account is not readable
    const result = verify({
      campaignAccount: { dataBase64: null, exists: false, lamports: null, owner: null },
    });

    // #when verified
    // #then it stays pending
    expect(result.verdict).toBe('pending');
    expect(result.code).toBe('CAMPAIGN_ACCOUNT_NOT_VISIBLE');
  });

  it('fails when the campaign address belongs to another programme', () => {
    // #given an account owned by a different programme
    const result = verify({ campaignAccount: { ...campaignAccount(), owner: SYSTEM_PROGRAM } });

    // #when verified
    // #then it is a failure, not a slow cluster
    expect(result.verdict).toBe('failed');
    expect(result.code).toBe('CAMPAIGN_ACCOUNT_WRONG_OWNER');
  });

  it('reports undecodable campaign data to an operator', () => {
    // #given an account with the right owner but the wrong layout
    const result = verify({
      campaignAccount: { ...campaignAccount(), dataBase64: Buffer.alloc(64).toString('base64') },
    });

    // #when verified
    // #then a layout mismatch is not silently confirmed
    expect(result.verdict).toBe('needs_reconciliation');
    expect(result.code).toBe('CAMPAIGN_ACCOUNT_UNDECODABLE');
  });

  it('fails when on-chain state disagrees with the committed terms', () => {
    // #given an account whose target differs from the draft
    const result = verify({ campaignAccount: campaignAccount(expected({ targetAmount: 1n })) });

    // #when verified
    // #then the mismatch is reported with the observed state
    expect(result.verdict).toBe('failed');
    expect(result.code).toBe('ON_CHAIN_STATE_MISMATCH');
    expect(result.onChain?.targetAmount).toBe('1');
  });

  it('waits when the vault account is not visible yet', () => {
    // #given the campaign account exists but the vault does not
    const result = verify({
      vaultAccount: { dataBase64: null, exists: false, lamports: null, owner: null },
    });

    // #when verified
    // #then it stays pending
    expect(result.code).toBe('VAULT_ACCOUNT_NOT_VISIBLE');
    expect(result.verdict).toBe('pending');
  });

  it('fails when the vault is not an SPL token account', () => {
    // #given a vault owned by the programme instead of the token programme
    const result = verify({ vaultAccount: { ...vaultAccount(), owner: PROGRAM_ID } });

    // #when verified
    // #then ownership is enforced
    expect(result.code).toBe('VAULT_WRONG_OWNER');
    expect(result.verdict).toBe('failed');
  });

  it('fails when the vault holds a different mint', () => {
    // #given a vault for another mint
    const data = Buffer.from(vaultAccount().dataBase64 as string, 'base64');
    bytes(CONFIG_PDA).copy(data, 0);

    // #when verified
    // #then the escrow is not the one the draft committed to
    const result = verify({ vaultAccount: { ...vaultAccount(), dataBase64: data.toString('base64') } });
    expect(result.code).toBe('VAULT_MISMATCH');
  });
});
