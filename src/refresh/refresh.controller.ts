import { Body, Controller, Get, Param, Post, Put, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RefreshService } from './refresh.service';
import { CronGuard } from '../common/guards/cron.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('api')
export class RefreshController {
  constructor(
    private readonly refresh: RefreshService,
    private readonly config: ConfigService,
  ) {}

  // Vercel Cron / external scheduler target (ТЗ §6/§16).
  // Vercel invokes cron jobs via GET (user-agent vercel-cron/1.0) and adds
  // `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET env var is set — so we
  // expose BOTH GET (Vercel scheduled run + dashboard "Run" button) and POST (external schedulers).
  @Get('cron/refresh')
  @UseGuards(CronGuard)
  cronGet() {
    return this.refresh.run('CRON');
  }

  @Post('cron/refresh')
  @UseGuards(CronGuard)
  cron() {
    return this.refresh.run('CRON');
  }

  // Browser-friendly manual trigger: open /api/refresh?key=<ADMIN_API_KEY> in a browser.
  // Key is passed as a query param (headers can't be set from the address bar).
  // Runs synchronously and returns the run summary (may take up to maxDuration on a cold catalog).
  @Get('refresh')
  refreshViaGet(@Query('key') key?: string) {
    const admin = this.config.get<string>('ADMIN_API_KEY');
    const cron = this.config.get<string>('CRON_SECRET');
    if (!key || (key !== admin && key !== cron)) {
      throw new UnauthorizedException('invalid or missing ?key');
    }
    return this.refresh.run('MANUAL');
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
