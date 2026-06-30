import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { RefreshService } from './refresh.service';

/**
 * Native scheduler for the PERSISTENT-PROCESS deployment (Railway/Render/VPS).
 * Disabled on Vercel serverless (set DISABLE_NATIVE_CRON=1), where vercel.json crons
 * call POST /api/cron/refresh instead (ТЗ §6/§16).
 */
@Injectable()
export class RefreshScheduler implements OnModuleInit {
  private readonly logger = new Logger(RefreshScheduler.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService,
    private readonly refresh: RefreshService,
  ) {}

  onModuleInit() {
    if (process.env.DISABLE_NATIVE_CRON === '1' || process.env.VERCEL) {
      this.logger.log('Native cron disabled (serverless) — using Vercel Cron endpoint');
      return;
    }
    const expr = this.config.get<string>('REFRESH_CRON')!;
    const tz = this.config.get<string>('REFRESH_TZ')!;
    const job = new CronJob(expr, () => this.tick(), null, true, tz);
    this.registry.addCronJob('refresh-cameras', job as any);
    job.start();
    this.logger.log(`Native cron scheduled: "${expr}" (${tz})`);
  }

  private async tick() {
    try { await this.refresh.run('CRON'); }
    catch (e) { this.logger.error(`Cron run failed: ${String(e)}`); }
  }
}
