import { Injectable } from '@nestjs/common';
import type { ClerkUser } from './clerk-auth.service';
import { SupabaseService } from './supabase.service';

@Injectable()
export class CommonService {
  constructor(private readonly supabaseService: SupabaseService) {}

  getWelcomeMessage(): string {
    return 'Common module is ready';
  }

  getRuntimeStatus(user?: ClerkUser) {
    return {
      ok: true,
      service: 'common',
      supabaseConfigured: this.supabaseService.isConfigured(),
      supabaseUrl: this.supabaseService.getProjectUrl(),
      authenticatedUserId: user?.userId ?? null,
    };
  }
}
