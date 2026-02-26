import { Global, Module } from '@nestjs/common';
import { CommonService } from './common.service';
import { SupabaseService } from './supabase.service';
import { ClerkAuthService } from './clerk-auth.service';
import { CommonController } from './common.controller';

@Global()
@Module({
  controllers: [CommonController],
  providers: [CommonService, SupabaseService, ClerkAuthService],
  exports: [CommonService, SupabaseService, ClerkAuthService],
})
export class OrgCommonModule {}
