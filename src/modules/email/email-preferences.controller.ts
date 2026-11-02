import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { escapeHtml } from '../../common/email';
import { EmailPreferencesService } from './email-preferences.service';

class UpdateEditorialPreferenceDto {
  @ApiProperty({
    description: 'Explicit editorial consent. Registration never sets this.',
  })
  @IsBoolean()
  subscribed!: boolean;
}

function preferencePage(input: {
  maskedEmail: string;
  subscribed: boolean;
  actionUrl: string;
}): string {
  const { maskedEmail, subscribed, actionUrl } = input;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Inverge email preferences</title>
    <style>
      body{margin:0;background:#FBF9F5;color:#1F1F1E;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}
      .wrap{max-width:520px;margin:48px auto;padding:0 20px;}
      .card{background:#FFFFFF;border:1px solid #EAE6E1;border-radius:16px;padding:32px;}
      .bar{height:4px;background:#1FA85C;border-radius:2px;width:56px;margin:0 0 24px;}
      h1{margin:0 0 12px;color:#0D1D15;font-size:24px;line-height:1.3;}
      p{margin:0 0 16px;color:#4B4B48;font-size:15px;line-height:1.65;}
      .who{color:#116B3A;font-weight:700;}
      button{background:#1FA85C;color:#FFFFFF;border:0;border-radius:10px;padding:14px 22px;font-size:15px;font-weight:700;cursor:pointer;}
      .muted{color:#71716E;font-size:12px;}
    </style>
  </head>
  <body>
    <main class="wrap">
      <div class="card">
        <div class="bar"></div>
        <h1>${subscribed ? 'Editorial email preferences' : 'You are unsubscribed'}</h1>
        <p class="who">${escapeHtml(maskedEmail)}</p>
        ${
          subscribed
            ? `<p>You are currently subscribed to Inverge editorial email, including The INVERGE Edit, idea and creator features, and competition announcements.</p>
               <p>Account, security, campaign and escrow messages are separate transactional email and are not affected.</p>
               <form method="post" action="${escapeHtml(actionUrl)}">
                 <button type="submit">Unsubscribe from editorial email</button>
               </form>`
            : `<p>You will not receive editorial email from Inverge at this address.</p>
               <p>Account, security, campaign and escrow messages are separate transactional email and are not affected.</p>`
        }
        <p class="muted" style="margin-top:24px;">Inverge never sells recipient lists. You can manage other email preferences from your account settings.</p>
      </div>
    </main>
  </body>
</html>`;
}

/** Signed-in preference management. */
@ApiTags('email')
@ApiBearerAuth()
@UseGuards(PrivyAuthGuard)
@Controller('me/email')
export class MeEmailController {
  constructor(private readonly preferences: EmailPreferencesService) {}

  @Get('preferences')
  @ApiOperation({ summary: 'Editorial consent and unsubscribe link state' })
  state(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.state(user.id);
  }

  @Put('editorial')
  @ApiOperation({
    summary: 'Opt in to or out of editorial email',
    description:
      'Explicit consent only. It does not change transactional account mail and registration never subscribes an account.',
  })
  setEditorial(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateEditorialPreferenceDto,
  ) {
    return this.preferences.setEditorial(user.id, dto.subscribed);
  }
}

/**
 * Public unsubscribe surface reached from an email. The GET renders a
 * confirmation page rather than unsubscribing on load, because mail scanners
 * prefetch links. The POST is also the RFC 8058 one-click target.
 */
@ApiTags('email')
@Controller('email/preferences')
export class EmailPreferencesController {
  constructor(private readonly preferences: EmailPreferencesService) {}

  @Get(':token')
  @RateLimit('email_preferences')
  async page(@Param('token') token: string, @Res() response: Response) {
    const state = await this.preferences.byToken(token);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    );
    response.setHeader('Cache-Control', 'no-store');
    response.send(
      preferencePage({
        actionUrl: `/api/v1/email/preferences/${encodeURIComponent(token)}/unsubscribe`,
        maskedEmail: state.email ?? 'this address',
        subscribed: state.subscribed,
      }),
    );
  }

  @Post(':token/unsubscribe')
  @HttpCode(200)
  @RateLimit('email_preferences')
  async unsubscribe(
    @Param('token') token: string,
    @Headers('accept') accept: string | undefined,
    @Res() response: Response,
  ) {
    const result = await this.preferences.unsubscribeByToken(token);
    if (accept?.includes('text/html')) {
      response.redirect(
        303,
        `/api/v1/email/preferences/${encodeURIComponent(token)}`,
      );
      return;
    }
    response.json({
      ...result,
      message: 'You will not receive Inverge editorial email.',
    });
  }
}
