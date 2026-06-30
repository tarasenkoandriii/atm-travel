import { Global, Module } from '@nestjs/common';
import { AdminGuard } from './guards/admin.guard';
import { CronGuard } from './guards/cron.guard';

@Global()
@Module({
  providers: [AdminGuard, CronGuard],
  exports: [AdminGuard, CronGuard],
})
export class CommonModule {}
