import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthService, type ClerkUser } from './clerk-auth.service';

export type AuthenticatedRequest = Request & {
  clerkUser?: ClerkUser;
};

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(private readonly clerkAuthService: ClerkAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header) {
      throw new UnauthorizedException('Authorization header is required');
    }

    request.clerkUser =
      await this.clerkAuthService.authenticateBearerToken(header);
    return true;
  }
}
