import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createClerkClient, verifyToken } from '@clerk/backend';

export type ClerkUser = {
  userId: string;
  sessionId?: string;
  token: string;
  claims: Record<string, unknown>;
};

@Injectable()
export class ClerkAuthService {
  private readonly secretKey = process.env.CLERK_SECRET_KEY?.trim() ?? '';
  private readonly jwtKey = process.env.CLERK_JWT_KEY?.trim() ?? '';
  private readonly audience = process.env.CLERK_AUDIENCE?.trim() ?? '';
  private readonly authorizedParties = (
    process.env.CLERK_AUTHORIZED_PARTIES ?? ''
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  readonly clerkClient = this.secretKey
    ? createClerkClient({ secretKey: this.secretKey })
    : null;

  isConfigured(): boolean {
    return Boolean(this.secretKey || this.jwtKey);
  }

  async authenticateBearerToken(rawHeader?: string): Promise<ClerkUser> {
    if (!rawHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Clerk Bearer token');
    }

    if (!this.isConfigured()) {
      throw new UnauthorizedException(
        'Clerk is not configured. Set CLERK_SECRET_KEY or CLERK_JWT_KEY.'
      );
    }

    const token = rawHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Empty Bearer token');
    }

    const payload = await verifyToken(token, {
      secretKey: this.secretKey || undefined,
      jwtKey: this.jwtKey || undefined,
      audience: this.audience || undefined,
      authorizedParties: this.authorizedParties.length
        ? this.authorizedParties
        : undefined,
    }).catch((error) => {
      throw new UnauthorizedException(
        `Invalid Clerk token: ${
          error instanceof Error ? error.message : 'verification failed'
        }`
      );
    });

    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) {
      throw new UnauthorizedException('Clerk token missing user subject');
    }

    return {
      userId,
      sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
      token,
      claims: payload as Record<string, unknown>,
    };
  }
}
