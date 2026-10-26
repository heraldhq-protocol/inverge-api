import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { AnalyticsIngestGuard } from './analytics-ingest.guard';
import { AnalyticsIngestService } from './analytics-ingest.service';
import {
  AnalyticsIngestResponseDto,
  IngestAnalyticsEventsDto,
} from './dto/analytics-ingest.dto';

@ApiTags('Internal analytics')
@ApiHeader({
  name: 'x-inverge-timestamp',
  required: true,
  description: 'Unix timestamp in seconds, within the configured clock skew.',
})
@ApiHeader({
  name: 'x-inverge-signature',
  required: true,
  description: 'HMAC-SHA256 of `${timestamp}.${rawBody}` as lowercase hex.',
})
@Controller('internal/analytics')
@UseGuards(AnalyticsIngestGuard)
export class InternalAnalyticsController {
  constructor(private readonly ingest: AnalyticsIngestService) {}

  @Post('events')
  @HttpCode(202)
  @RateLimit('analytics_ingest')
  @ApiOperation({
    summary: 'Ingest server-observed analytics events',
    description:
      'Signed service-to-service route. Accepts views and step attempts only; confirmed outcomes are written by the domain after commit.',
  })
  @ApiAcceptedResponse({ type: AnalyticsIngestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing, stale or invalid signature.' })
  @ApiPayloadTooLargeResponse({ description: 'Batch body exceeds the configured limit.' })
  @ApiTooManyRequestsResponse({ description: 'Ingest rate limit exceeded.' })
  @ApiServiceUnavailableResponse({ description: 'Ingest or persistence is unavailable.' })
  ingestEvents(
    @Body() dto: IngestAnalyticsEventsDto,
  ): Promise<AnalyticsIngestResponseDto> {
    return this.ingest.ingest(dto.events);
  }
}
