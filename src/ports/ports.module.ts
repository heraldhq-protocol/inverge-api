import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';

import { EMBEDDED_WALLET_PORT } from './wallet/embedded-wallet.port';
import { StubWalletAdapter } from './wallet/stub-wallet.adapter';
import { PrivyWalletAdapter } from './wallet/privy-wallet.adapter';

import { FLAT_FEE_PAYMENT_PORT } from './flat-fee/flat-fee-payment.port';
import { StubFlatFeeAdapter } from './flat-fee/stub-flat-fee.adapter';
import { PaystackFlatFeeAdapter } from './flat-fee/paystack-flat-fee.adapter';

import { KYC_PROVIDER_PORT } from './kyc/kyc-provider.port';
import { StubKycAdapter } from './kyc/stub-kyc.adapter';

import { NOTIFICATION_PORT } from './notification/notification.port';
import { StubNotificationAdapter } from './notification/stub-notification.adapter';
import { HeraldNotificationAdapter } from './notification/herald-notification.adapter';

import { QUALITY_SCORER_PORT } from './quality/quality-scorer.port';
import { StubQualityScorerAdapter } from './quality/stub-quality-scorer.adapter';

import { MODERATION_CLASSIFIER_PORT } from './moderation/moderation.port';
import { StubModerationAdapter } from './moderation/stub-moderation.adapter';
import { AiModerationAdapter } from './moderation/ai-moderation.adapter';

import { DUPLICATE_DETECTOR_PORT } from './dedup/dedup.port';
import { StubShingleDetector } from './dedup/stub-shingle-detector.adapter';

// Binds each port token to an adapter selected by env. Adapters are all constructed
// (cheap), the factory picks one — so swapping a vendor is an env flip, and adding a
// new vendor is a new adapter file. No business logic references a concrete vendor.
@Global()
@Module({
  providers: [
    StubWalletAdapter,
    PrivyWalletAdapter,
    StubFlatFeeAdapter,
    PaystackFlatFeeAdapter,
    StubKycAdapter,
    StubNotificationAdapter,
    HeraldNotificationAdapter,
    StubQualityScorerAdapter,
    StubModerationAdapter,
    AiModerationAdapter,
    StubShingleDetector,
    {
      provide: EMBEDDED_WALLET_PORT,
      inject: [ConfigService, StubWalletAdapter, PrivyWalletAdapter],
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubWalletAdapter,
        privy: PrivyWalletAdapter,
      ) => (config.get('WALLET_PROVIDER', { infer: true }) === 'privy' ? privy : stub),
    },
    {
      provide: FLAT_FEE_PAYMENT_PORT,
      inject: [ConfigService, StubFlatFeeAdapter, PaystackFlatFeeAdapter],
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubFlatFeeAdapter,
        paystack: PaystackFlatFeeAdapter,
      ) =>
        config.get('FLATFEE_PROVIDER', { infer: true }) === 'paystack' ? paystack : stub,
    },
    {
      provide: KYC_PROVIDER_PORT,
      inject: [StubKycAdapter],
      // 'smile' adapter lands at Phase 1; stub is the only Phase 0 KYC path.
      useFactory: (stub: StubKycAdapter) => stub,
    },
    {
      provide: NOTIFICATION_PORT,
      inject: [ConfigService, StubNotificationAdapter, HeraldNotificationAdapter],
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubNotificationAdapter,
        herald: HeraldNotificationAdapter,
      ) =>
        config.get('NOTIFICATION_PROVIDER', { infer: true }) === 'herald'
          ? herald
          : stub,
    },
    {
      provide: QUALITY_SCORER_PORT,
      inject: [StubQualityScorerAdapter],
      // 'claude' AI adapter lands at Phase 1; stub (deterministic) is the Phase 0 path.
      useFactory: (stub: StubQualityScorerAdapter) => stub,
    },
    {
      provide: MODERATION_CLASSIFIER_PORT,
      inject: [ConfigService, StubModerationAdapter, AiModerationAdapter],
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubModerationAdapter,
        ai: AiModerationAdapter,
      ) => (config.get('MODERATION_PROVIDER', { infer: true }) === 'ai' ? ai : stub),
    },
    {
      provide: DUPLICATE_DETECTOR_PORT,
      inject: [StubShingleDetector],
      // Deterministic shingle detector now; a semantic adapter can drop in later.
      useFactory: (stub: StubShingleDetector) => stub,
    },
  ],
  exports: [
    EMBEDDED_WALLET_PORT,
    FLAT_FEE_PAYMENT_PORT,
    KYC_PROVIDER_PORT,
    NOTIFICATION_PORT,
    QUALITY_SCORER_PORT,
    MODERATION_CLASSIFIER_PORT,
    DUPLICATE_DETECTOR_PORT,
  ],
})
export class PortsModule {}
