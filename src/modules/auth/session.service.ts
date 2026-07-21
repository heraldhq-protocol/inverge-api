import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, SignJWT } from 'jose';
import { Env } from '../../config/env.validation';

export interface SessionPayload {
  sub: string; // User.id
}

// Short-lived session tokens (NFR-03). Issued after the wallet/auth provider
// verifies the user; subsequent requests carry this token.
@Injectable()
export class SessionService {
  private readonly secret: Uint8Array;

  constructor(config: ConfigService<Env, true>) {
    this.secret = new TextEncoder().encode(
      config.get('SESSION_JWT_SECRET', { infer: true }),
    );
  }

  async sign(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.secret);
  }

  async verify(token: string): Promise<SessionPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      if (!payload.sub) throw new Error('missing subject');
      return { sub: payload.sub };
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}
