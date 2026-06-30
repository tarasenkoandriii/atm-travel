import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

// Protects /api/cron/refresh. Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" (ТЗ §6/§16).
@Injectable()
export class CronGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.headers['authorization'] || '';
    const secret = this.config.get<string>('CRON_SECRET');
    const bearer = `Bearer ${secret}`;
    // Allow either Vercel Bearer header or explicit X-Cron-Secret for manual/external triggers.
    if (auth === bearer || req.headers['x-cron-secret'] === secret) return true;
    throw new UnauthorizedException('Invalid cron secret');
  }
}
