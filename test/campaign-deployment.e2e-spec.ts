import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ChainUnavailableError,
  ESCROW_CHAIN_PORT,
  type ChainAccount,
  type ChainTransaction,
  type EscrowChainPort,
} from '../src/ports/escrow/escrow-chain.port';
import {
  CREATE_CAMPAIGN_ACCOUNTS,
  TOKEN_PROGRAM_ID,
  decodeCreateCampaignInstruction,
} from '../src/modules/campaigns/deployment/anchor-escrow';
import { base58ToBytes } from '../src/common/utils/base58.util';

/**
 * Draft persistence, deployment preparation and post-signature verification over
 * HTTP, with the cluster replaced by a deterministic fake.
 *
 * The fake is not a convenience: it lets the suite prove that a signature alone
 * never confirms a deployment (a "missing" or "unavailable" answer must leave the
 * attempt reconcilable), while the confirmation path runs the real decoder and
 * verifier against bytes the API itself produced.
 */

const PROGRAM_ID = '38rarxmrSL3rjCN2bwdDfQNLtpYRgLGp96xfkPXv39S1';
const CREATOR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CONFIG_PDA = 'So11111111111111111111111111111111111111112';
const CAMPAIGN_PDA = '9xQeWvG816bUx9EPf2ZB6d9c3nd8kGKw9gCjALZfG7Ns';
const VAULT_PDA = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

type Mode = 'missing' | 'ok' | 'unavailable';

interface FakeChain extends EscrowChainPort {
  accounts: Map<string, ChainAccount>;
  mode: Mode;
  tx: ChainTransaction | null;
}

function notFoundAccount(): ChainAccount {
  return { dataBase64: null, exists: false, lamports: null, owner: null };
}

function mintAccount(decimals = 6): ChainAccount {
  const data = Buffer.alloc(82);
  data.writeUInt8(1, 0); // COption::Some for the mint authority
  data.writeUInt8(1, 45); // is_initialized
  data.writeUInt8(decimals, 44);
  return { dataBase64: data.toString('base64'), exists: true, lamports: 1_461_600n, owner: TOKEN_PROGRAM_ID };
}

function bytes(address: string): Buffer {
  return Buffer.from(base58ToBytes(address));
}

function campaignAccount(input: {
  campaignIdHex: string;
  creator: string;
  deadline: number;
  floorAmount: bigint;
  milestones: readonly { deadline: number; evidenceHash: string; trancheBps: number }[];
  targetAmount: bigint;
  termsHash: string;
  tokenMint: string;
  workingCapitalBps: number;
}): ChainAccount {
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
  write(bytes(input.creator));
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

  return { dataBase64: data.toString('base64'), exists: true, lamports: 2_039_280n, owner: PROGRAM_ID };
}

function vaultAccount(): ChainAccount {
  const data = Buffer.alloc(165);
  bytes(MINT).copy(data, 0);
  bytes(VAULT_PDA).copy(data, 32);
  data.writeUInt8(1, 108);
  return { dataBase64: data.toString('base64'), exists: true, lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID };
}

function signature(char: string): string {
  return char.repeat(88);
}

// This suite boots the full application and links wallets; the shared 30 s hook
// budget is for fixtures, not for a cold database connection on CI.
jest.setTimeout(120_000);

describe('Campaign draft and escrow deployment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let chain: FakeChain;
  let creatorId: string;
  let creatorToken: string;
  let strangerId: string;
  let strangerToken: string;
  const campaignIds: string[] = [];
  const RUN = Date.now().toString(36);

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function session(accessToken: string) {
    const res = await http().post('/api/v1/auth/session').send({ accessToken }).expect(201);
    return { id: res.body.user.id as string, token: res.body.sessionToken as string };
  }

  function draftBody(overrides: Record<string, unknown> = {}) {
    return {
      beneficiaries: 'Smallholder farmers in the pilot region',
      category: undefined,
      deadline: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      location: 'Lagos, Nigeria',
      milestones: [
        {
          allocationPercent: '50',
          deliverable: 'Install and commission the first cold room',
          evidence: 'Signed installation report from the site engineer',
          expectedAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
          title: 'Pilot cold room',
        },
        {
          allocationPercent: '50',
          deliverable: 'Publish audited operating results for the quarter',
          evidence: 'Audited report published on the campaign page',
          expectedAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
          title: 'Operating report',
        },
      ],
      objectionWindowDays: 7,
      problem: 'Produce spoils before it reaches the market, destroying income.',
      solution: 'Solar-powered cold rooms close to the farms, paid per use.',
      story: undefined,
      summary: 'A solar cold-chain pilot that cuts post-harvest losses for farmers.',
      targetAmount: '5000.00',
      title: 'Solar cold chain',
      tokenType: 'USDC',
      workingCapitalPercent: '20',
      ...overrides,
    };
  }

  async function createDraft(body = draftBody()): Promise<string> {
    const res = await http()
      .post('/api/v1/campaigns')
      .set(bearer(creatorToken))
      .send(body)
      .expect(201);
    campaignIds.push(res.body.id as string);
    return res.body.id as string;
  }

  function prepare(campaignId: string, acceptTerms = true) {
    return http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/prepare`)
      .set(bearer(creatorToken))
      .send({ acceptTerms });
  }

  /**
   * Registers the transaction and accounts a creator's wallet would have
   * produced for this prepared attempt. Instruction bytes come from the API's own
   * preparation response, so the verifier is exercised against real data.
   */
  function registerDeployment(prepared: {
    creatorWallet: string;
    instruction: { dataBase64: string };
    tokenMint: string;
  }) {
    const args = decodeCreateCampaignInstruction(
      Buffer.from(prepared.instruction.dataBase64, 'base64'),
    );
    if (!args) throw new Error('The API did not return a decodable create_campaign instruction');

    const accounts = [
      CONFIG_PDA,
      CAMPAIGN_PDA,
      prepared.tokenMint,
      VAULT_PDA,
      prepared.creatorWallet,
      SYSTEM_PROGRAM,
      TOKEN_PROGRAM_ID,
    ];
    expect(accounts).toHaveLength(CREATE_CAMPAIGN_ACCOUNTS.length);

    chain.accounts.set(
      CAMPAIGN_PDA,
      campaignAccount({
        campaignIdHex: args.campaignId,
        creator: prepared.creatorWallet,
        deadline: args.deadline,
        floorAmount: args.floorAmount,
        milestones: args.milestones,
        targetAmount: args.targetAmount,
        termsHash: args.termsHash,
        tokenMint: prepared.tokenMint,
        workingCapitalBps: args.workingCapitalBps,
      }),
    );
    chain.accounts.set(VAULT_PDA, vaultAccount());
    chain.tx = {
      blockTime: Math.floor(Date.now() / 1000),
      commitment: 'finalized',
      error: null,
      found: true,
      instructions: [
        {
          accounts,
          dataBase64: prepared.instruction.dataBase64,
          programId: PROGRAM_ID,
        },
      ],
      slot: 456,
      success: true,
    };
  }

  beforeAll(async () => {
    chain = {
      accounts: new Map([[MINT, mintAccount(6)]]),
      cluster: 'devnet',
      commitment: 'finalized',
      configured: true,
      mode: 'ok',
      programId: PROGRAM_ID,
      tx: null,
      async getAccount(address: string) {
        return this.accounts.get(address) ?? notFoundAccount();
      },
      async getRentExemptionLamports() {
        return 1_000_000n;
      },
      async getTransaction() {
        if (this.mode === 'unavailable') {
          throw new ChainUnavailableError('The Solana RPC request timed out.');
        }
        if (this.mode === 'missing' || !this.tx) {
          return {
            blockTime: null,
            commitment: null,
            error: null,
            found: false,
            instructions: [],
            slot: null,
            success: false,
          };
        }
        return this.tx;
      },
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ESCROW_CHAIN_PORT)
      .useValue(chain)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    ({ id: creatorId, token: creatorToken } = await session(`d${RUN}`));
    ({ id: strangerId, token: strangerToken } = await session(`e${RUN}`));

    await prisma.walletAccount.create({
      data: { address: CREATOR, isEmbedded: true, provider: 'external', userId: creatorId },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      await prisma.user.deleteMany({
        where: { id: { in: [creatorId, strangerId] } },
      });
    }
    if (app) await app.close();
  });

  it('requires authentication for every creator route', async () => {
    await http().post('/api/v1/campaigns').send(draftBody()).expect(401);
    await http().patch('/api/v1/campaigns/anything').send({ version: 0 }).expect(401);
    await http().post('/api/v1/campaigns/anything/deployment/prepare').send({}).expect(401);
  });

  it('persists a draft before any wallet prompt and reports readiness', async () => {
    // #given a complete creator payload
    const res = await http()
      .post('/api/v1/campaigns')
      .set(bearer(creatorToken))
      .send(draftBody())
      .expect(201);
    campaignIds.push(res.body.id);

    // #when the draft is read back
    // #then the authored content and milestones are stored, not browser state
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      targetAmount: '5000.00',
      tokenType: 'USDC',
      version: 0,
      workingCapitalPercent: '20.00',
    });
    expect(res.body.milestones).toHaveLength(2);
    expect(res.body.milestones[0]).toMatchObject({ index: 0, allocationPercent: '50.00' });
    expect(res.body.readiness.ready).toBe(true);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.draftVersion).toBe(0);
    expect(stored.status).toBe('DRAFT');
    expect(await prisma.campaignDeployment.count({ where: { campaignId: stored.id } })).toBe(0);
  });

  it('rejects a working-capital value other than the fixed 20%', async () => {
    // #given a creator still sending the superseded 25% band
    const res = await http()
      .post('/api/v1/campaigns')
      .set(bearer(creatorToken))
      .send(draftBody({ workingCapitalPercent: '25' }))
      .expect(400);

    // #then the DTO boundary refuses the value and names the fixed rate
    expect(JSON.stringify(res.body)).toContain('exactly 20');
  });

  it('rejects a stale autosave instead of overwriting a newer one', async () => {
    // #given a draft saved by one tab
    const campaignId = campaignIds[0]!;
    const first = await http()
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(bearer(creatorToken))
      .send({ title: 'Solar cold chain v2', version: 0 })
      .expect(200);
    expect(first.body.version).toBe(1);

    // #when a second tab saves against the old version
    const stale = await http()
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(bearer(creatorToken))
      .send({ title: 'Stale tab wins', version: 0 })
      .expect(409);

    // #then the write is refused and the newer title survives
    expect(stale.body.error.code).toBe('STALE_DRAFT_VERSION');
    expect(stale.body.error.details.currentVersion).toBe(1);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(stored.title).toBe('Solar cold chain v2');
    expect(stored.draftVersion).toBe(1);
  });

  it('keeps drafts owner-scoped', async () => {
    // #given a campaign owned by the creator
    const campaignId = campaignIds[0]!;

    // #when another user reads or writes it
    // #then ownership is enforced before any state is exposed
    await http()
      .get(`/api/v1/campaigns/${campaignId}/draft`)
      .set(bearer(strangerToken))
      .expect(403);
    await http()
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(bearer(strangerToken))
      .send({ title: 'Hijacked', version: 1 })
      .expect(403);
    // #then ownership is enforced and an unprepared campaign is indistinguishable
    // from one the caller does not own (no existence leak)
    await http()
      .get(`/api/v1/campaigns/${campaignId}/deployment`)
      .set(bearer(strangerToken))
      .expect(404);
  });

  it('refuses to prepare without explicit terms acceptance or readiness', async () => {
    const campaignId = campaignIds[0]!;

    // #given a complete draft
    // #when terms are not accepted
    const refused = await prepare(campaignId, false).expect(400);
    // #then nothing is prepared
    expect(refused.body.error.code).toBe('TERMS_NOT_ACCEPTED');
    expect(await prisma.campaignDeployment.count({ where: { campaignId } })).toBe(0);

    // #given an incomplete draft
    const incompleteId = await createDraft(
      draftBody({
        milestones: draftBody().milestones.map((milestone) => ({
          ...milestone,
          allocationPercent: '40',
        })),
      }),
    );
    // #when prepare is attempted
    const blocked = await prepare(incompleteId).expect(400);
    // #then the server's readiness verdict names the blockers
    expect(blocked.body.error.code).toBe('CAMPAIGN_NOT_READY');
    expect(blocked.body.error.details.blockers.length).toBeGreaterThan(0);
  });

  it('prepares one server-built instruction and returns the same attempt on retry', async () => {
    const campaignId = campaignIds[0]!;

    // #given a ready draft and a configured cluster
    const res = await prepare(campaignId).expect(200);

    // #when prepared
    // #then the instruction, accounts and fee facts are server-derived
    expect(res.body).toMatchObject({
      attemptNo: 1,
      canSign: true,
      cluster: 'devnet',
      commitment: 'finalized',
      creatorWallet: CREATOR,
      programId: PROGRAM_ID,
      status: 'READY',
      tokenMint: MINT,
    });
    expect(res.body.fee).toMatchObject({ mode: 'not_required', status: 'NOT_REQUIRED' });
    expect(res.body.instruction.programId).toBe(PROGRAM_ID);
    expect(res.body.instruction.accounts).toHaveLength(7);
    expect(res.body.campaignPda).toBeNull();
    expect(res.body.termsHash).toMatch(/^[0-9a-f]{64}$/);

    const decoded = decodeCreateCampaignInstruction(
      Buffer.from(res.body.instruction.dataBase64, 'base64'),
    );
    expect(decoded).not.toBeNull();

    // #when prepare is called again
    const again = await prepare(campaignId).expect(200);

    // #then the same attempt is returned rather than a second one
    expect(again.body.attemptId).toBe(res.body.attemptId);
    expect(again.body.attemptNo).toBe(1);
    expect(await prisma.campaignDeployment.count({ where: { campaignId } })).toBe(1);
    expect(
      await prisma.campaignTermsAcceptance.count({ where: { campaignId } }),
    ).toBe(1);

    // #when another user reads the prepared attempt
    // #then ownership is checked before its contents are returned
    await http()
      .get(`/api/v1/campaigns/${campaignId}/deployment`)
      .set(bearer(strangerToken))
      .expect(403);
  });

  it('confirms a deployment only after verifying the on-chain accounts', async () => {
    const campaignId = campaignIds[0]!;
    const prepared = (await prepare(campaignId).expect(200)).body;
    registerDeployment(prepared);

    // #given a signed transaction whose accounts match the prepared terms
    const submitted = await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/submit`)
      .set(bearer(creatorToken))
      .send({ attemptId: prepared.attemptId, signature: signature('2') })
      .expect(200);

    // #when verified
    // #then the escrow is recorded and linked to the campaign
    expect(submitted.body).toMatchObject({
      campaignPda: CAMPAIGN_PDA,
      escrowVault: VAULT_PDA,
      status: 'CONFIRMED',
      txSignature: signature('2'),
    });
    expect(submitted.body.verifiedAt).toBeTruthy();
    expect(submitted.body.explorerUrl).toContain('cluster=devnet');

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.escrowPdaAddress).toBe(CAMPAIGN_PDA);
    expect(campaign.termsHash).toBe(prepared.termsHash);
    expect(campaign.status).toBe('DRAFT');

    // #when the same signature is submitted again
    const replay = await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/submit`)
      .set(bearer(creatorToken))
      .send({ signature: signature('2') })
      .expect(200);

    // #then it is idempotent, not a second attempt or an error
    expect(replay.body.status).toBe('CONFIRMED');
    expect(replay.body.attemptNo).toBe(1);
  });

  it('refuses publication until review approves, then publishes once', async () => {
    const campaignId = campaignIds[0]!;

    // #given a verified deployment that is still unreviewed
    const blocked = await http()
      .post(`/api/v1/campaigns/${campaignId}/publish`)
      .set(bearer(creatorToken))
      .expect(400);
    // #when publish is attempted
    // #then review is named as the outstanding gate
    expect(blocked.body.error.details.blockers.join(' ')).toContain('Curation review');

    // #given an approved campaign in review
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { reviewStatus: 'APPROVED', status: 'IN_REVIEW' },
    });

    // #when published
    const published = await http()
      .post(`/api/v1/campaigns/${campaignId}/publish`)
      .set(bearer(creatorToken))
      .expect(200);

    // #then the campaign goes live and the deployment records it
    expect(published.body).toMatchObject({ status: 'ACTIVE' });
    expect(published.body.launchedAt).toBeTruthy();
    const events = await prisma.campaignDeploymentEvent.findMany({
      where: { deployment: { campaignId }, type: 'PUBLISHED' },
    });
    expect(events).toHaveLength(1);

    // #when publication is retried
    // #then it is refused rather than writing a second launch
    await http()
      .post(`/api/v1/campaigns/${campaignId}/publish`)
      .set(bearer(creatorToken))
      .expect(400);
  });

  it('leaves a deployment reconcilable when the cluster is unavailable', async () => {
    // #given a prepared attempt
    const campaignId = await createDraft();
    const prepared = (await prepare(campaignId).expect(200)).body;
    registerDeployment(prepared);
    chain.mode = 'unavailable';

    // #when submit cannot reach the cluster
    const res = await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/submit`)
      .set(bearer(creatorToken))
      .send({ signature: signature('3') })
      .expect(200);

    // #then the transaction is not reported as failed and no auto-redeploy happens
    expect(res.body.status).toBe('CONFIRMING');
    expect(res.body.lastError.code).toBe('CHAIN_UNAVAILABLE');
    const stored = await prisma.campaignDeployment.findUniqueOrThrow({ where: { campaignId } });
    expect(stored.status).toBe('CONFIRMING');
    expect(stored.txSignature).toBe(signature('3'));
    expect(stored.nextReconcileAt).toBeTruthy();

    // #when the cluster recovers and reconciliation runs
    chain.mode = 'ok';
    const reconciled = await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/reconcile`)
      .set(bearer(creatorToken))
      .expect(200);

    // #then the same attempt confirms without a new signature
    expect(reconciled.body).toMatchObject({ status: 'CONFIRMED' });
    expect(reconciled.body.attemptNo).toBe(1);
  });

  it('treats an unseen transaction as pending, not as a failure', async () => {
    // #given a prepared attempt whose transaction the cluster has not seen
    const campaignId = await createDraft();
    const prepared = (await prepare(campaignId).expect(200)).body;
    registerDeployment(prepared);
    chain.mode = 'missing';

    // #when submitted
    const res = await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/submit`)
      .set(bearer(creatorToken))
      .send({ signature: signature('4') })
      .expect(200);

    // #then it waits with a bounded next check rather than failing
    expect(res.body.status).toBe('CONFIRMING');
    expect(res.body.lastError.code).toBe('TRANSACTION_NOT_FOUND');
    expect(res.body.reconcileAttempts).toBe(1);
  });

  it('rejects a signature already recorded for another campaign', async () => {
    // #given a signature confirmed for the first campaign
    const campaignId = await createDraft();
    const prepared = (await prepare(campaignId).expect(200)).body;
    registerDeployment(prepared);

    // #when another campaign submits the same signature
    const res = await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/submit`)
      .set(bearer(creatorToken))
      .send({ signature: signature('2') })
      .expect(409);

    // #then the idempotency key is global and nothing is overwritten
    expect(res.body.error.code).toBe('SIGNATURE_ALREADY_USED');
    const stored = await prisma.campaignDeployment.findUniqueOrThrow({ where: { campaignId } });
    expect(stored.status).toBe('READY');
    expect(stored.txSignature).toBeNull();
  });

  it('returns 404 for a campaign that was never prepared', async () => {
    const campaignId = await createDraft();
    await http()
      .get(`/api/v1/campaigns/${campaignId}/deployment`)
      .set(bearer(creatorToken))
      .expect(404);
    await http()
      .post(`/api/v1/campaigns/${campaignId}/deployment/reconcile`)
      .set(bearer(creatorToken))
      .expect(404);
  });
});
