import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { PortsModule } from './ports.module';
import {
  EMBEDDED_WALLET_PORT,
  EmbeddedWalletPort,
} from './wallet/embedded-wallet.port';
import { StubWalletAdapter } from './wallet/stub-wallet.adapter';
import { Web3AuthWalletAdapter } from './wallet/web3auth-wallet.adapter';
import {
  FLAT_FEE_PAYMENT_PORT,
  FlatFeePaymentPort,
} from './flat-fee/flat-fee-payment.port';
import { StubFlatFeeAdapter } from './flat-fee/stub-flat-fee.adapter';
import { PaystackFlatFeeAdapter } from './flat-fee/paystack-flat-fee.adapter';
import { KYC_PROVIDER_PORT, KycProviderPort } from './kyc/kyc-provider.port';
import { StubKycAdapter } from './kyc/stub-kyc.adapter';
import { DiditKycAdapter } from './kyc/didit-kyc.adapter';

/**
 * Compiles the real PortsModule so the assertion covers the factory wiring, not
 * only the env schema. `ignoreEnvFile` keeps the result independent of a
 * developer's .env; the fake validator supplies the scenario's environment.
 * Prisma is replaced because the shingle detector is unrelated to this assertion.
 */
async function portsFor(env: Record<string, string>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validate: () => ({
          DATABASE_URL: 'postgresql://inverge:inverge@localhost:5432/inverge',
          ...env,
        }),
      }),
      PrismaModule,
      PortsModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

const REAL_PRODUCTION = {
  NODE_ENV: 'production',
  WALLET_PROVIDER: 'web3auth',
  WEB3AUTH_CLIENT_ID: 'client-id',
  KYC_PROVIDER: 'didit',
  DIDIT_API_KEY: 'didit-key',
  FLATFEE_PROVIDER: 'paystack',
  PAYSTACK_SECRET_KEY: 'sk_test_example',
};

describe('PortsModule provider selection (F-01)', () => {
  it('binds the offline adapters outside production', async () => {
    const moduleRef = await portsFor({
      NODE_ENV: 'test',
      WALLET_PROVIDER: 'stub',
      KYC_PROVIDER: 'stub',
      FLATFEE_PROVIDER: 'stub',
    });

    expect(moduleRef.get(EMBEDDED_WALLET_PORT)).toBeInstanceOf(StubWalletAdapter);
    expect(moduleRef.get(KYC_PROVIDER_PORT)).toBeInstanceOf(StubKycAdapter);
    expect(moduleRef.get(FLAT_FEE_PAYMENT_PORT)).toBeInstanceOf(StubFlatFeeAdapter);
    await moduleRef.close();
  });

  it('binds the configured real adapters instead of a stub', async () => {
    const moduleRef = await portsFor(REAL_PRODUCTION);

    expect(moduleRef.get(EMBEDDED_WALLET_PORT)).toBeInstanceOf(
      Web3AuthWalletAdapter,
    );
    expect(moduleRef.get(KYC_PROVIDER_PORT)).toBeInstanceOf(DiditKycAdapter);
    expect(moduleRef.get(FLAT_FEE_PAYMENT_PORT)).toBeInstanceOf(
      PaystackFlatFeeAdapter,
    );
    await moduleRef.close();
  });

  it('never lets a stub-bound port authenticate or charge in production', async () => {
    const walletModule = await portsFor({
      ...REAL_PRODUCTION,
      WALLET_PROVIDER: 'stub',
    });
    const wallet = walletModule.get<EmbeddedWalletPort>(EMBEDDED_WALLET_PORT);
    expect(wallet).toBeInstanceOf(StubWalletAdapter);
    await expect(wallet.verifyAccessToken('stub:attacker')).rejects.toThrow(
      /stub wallet provider/i,
    );
    await walletModule.close();

    const kycModule = await portsFor({
      ...REAL_PRODUCTION,
      KYC_PROVIDER: 'stub',
    });
    const kyc = kycModule.get<KycProviderPort>(KYC_PROVIDER_PORT);
    expect(kyc).toBeInstanceOf(StubKycAdapter);
    await expect(
      kyc.startVerification({ vendorData: 'u1', purpose: 'IDEA_VALIDATION' }),
    ).rejects.toThrow(/stub KYC provider/i);
    await kycModule.close();

    const flatFeeModule = await portsFor({
      ...REAL_PRODUCTION,
      FLATFEE_PROVIDER: 'stub',
    });
    const flatFee = flatFeeModule.get<FlatFeePaymentPort>(FLAT_FEE_PAYMENT_PORT);
    expect(flatFee).toBeInstanceOf(StubFlatFeeAdapter);
    await expect(
      flatFee.createCharge({
        userId: 'u1',
        purpose: 'APPLICATION_FEE',
        amount: 1000,
        currency: 'NGN',
      }),
    ).rejects.toThrow(/stub flat-fee provider/i);
    await flatFeeModule.close();
  });
});
