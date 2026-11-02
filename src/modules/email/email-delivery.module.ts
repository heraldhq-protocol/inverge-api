import { Module } from '@nestjs/common';
import { EmailContextService } from './email-context.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailSuppressionService } from './email-suppression.service';

/**
 * The shared send path, deliberately separate from the preference, webhook and
 * admin surfaces so `AuthModule` can use it without importing the controllers.
 * `EMAIL_PORT` comes from the global PortsModule; this module never binds a
 * vendor itself.
 */
@Module({
  providers: [
    EmailContextService,
    EmailDeliveryService,
    EmailSuppressionService,
  ],
  exports: [
    EmailContextService,
    EmailDeliveryService,
    EmailSuppressionService,
  ],
})
export class EmailDeliveryModule {}
