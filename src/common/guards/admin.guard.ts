import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

// Protects /api/admin/* via X-Admin-Key (ТЗ §12).
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = req.headers['x-admin-key'];
    if (!key || key !== this.config.get<string>('ADMIN_API_KEY')) {
      throw new UnauthorizedException('Invalid admin key');
    }
    return true;
  }
}
