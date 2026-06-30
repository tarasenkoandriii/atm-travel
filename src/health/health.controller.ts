import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  async health() {
    let db = false;
    try { await this.prisma.$queryRawUnsafe('SELECT 1'); db = true; } catch {}
    return { status: db ? 'ok' : 'degraded', db, ts: new Date().toISOString() };
  }
}
