import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { RefreshService } from './refresh.service';
import { CronGuard } from '../common/guards/cron.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('api')
export class RefreshController {
  constructor(private readonly refresh: RefreshService) {}

  // Vercel Cron / external scheduler target (ТЗ §6/§16)
  @Post('cron/refresh')
  @UseGuards(CronGuard)
  cron() {
    return this.refresh.run('CRON');
  }

  // Admin: manual trigger + history
  @Post('admin/refresh')
  @UseGuards(AdminGuard)
  manual() {
    return this.refresh.run('MANUAL');
  }

  @Get('admin/refresh/runs')
  @UseGuards(AdminGuard)
  runs() {
    return this.refresh.recentRuns();
  }

  @Get('admin/refresh/runs/:id')
  @UseGuards(AdminGuard)
  run(@Param('id') id: string) {
    return this.refresh.getRun(id);
  }
}
