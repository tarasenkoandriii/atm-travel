import { Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embeddings.service';

@Controller('api/embed')
export class EmbeddingsController {
  constructor(private readonly config: ConfigService, private readonly svc: EmbeddingService) {}

  private ok(auth?: string, xsec?: string): boolean {
    const s = this.config.get<string>('CRON_SECRET');
    return !!s && (auth === `Bearer ${s}` || xsec === s);
  }

  // Hourly embed run (pg_cron): re-embed only semantically-changed tours, capped per run.
  @Post('run')
  async runPost(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.ok(auth, xsec)) throw new UnauthorizedException('Invalid cron secret');
    return { ok: true, ...(await this.svc.embedChanged()) };
  }
  @Get('run')
  async runGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.ok(auth, xsec)) throw new UnauthorizedException('Invalid cron secret');
    return { ok: true, ...(await this.svc.embedChanged()) };
  }
}
