import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient | null;
  private readonly supabaseUrl = process.env.SUPABASE_URL?.trim() ?? '';
  private readonly supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    process.env.SUPABASE_ANON_KEY?.trim() ??
    '';
  private readonly configError: string | null;

  constructor() {
    this.configError = this.validateConfig();

    if (this.configError) {
      this.client = null;
      return;
    }

    this.client =
      this.supabaseUrl && this.supabaseKey
        ? createClient(this.supabaseUrl, this.supabaseKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null;
  }

  private validateConfig(): string | null {
    if (!this.supabaseUrl && !this.supabaseKey) {
      return null;
    }

    if (!this.supabaseUrl) {
      return 'Missing SUPABASE_URL';
    }

    if (!this.supabaseKey) {
      return 'Missing SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)';
    }

    try {
      const parsed = new URL(this.supabaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'SUPABASE_URL must use http or https';
      }
    } catch {
      return 'SUPABASE_URL must be a valid HTTP/HTTPS URL';
    }

    return null;
  }

  isConfigured(): boolean {
    return this.client !== null && !this.configError;
  }

  getProjectUrl(): string | null {
    return this.supabaseUrl || null;
  }

  getClient(): SupabaseClient {
    if (!this.client) {
      throw new InternalServerErrorException(
        `Supabase is not configured${
          this.configError ? `: ${this.configError}` : ''
        }. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`
      );
    }

    return this.client;
  }
}
