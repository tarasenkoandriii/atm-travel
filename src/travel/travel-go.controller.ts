import { Controller, Get, Query, Res, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { TravelService } from './travel.service';

@Controller()
export class TravelGoController {
  constructor(private readonly travel: TravelService, private readonly config: ConfigService) {}

  // Destination hosts we allow to 302 to (prevents open-redirect abuse via ?u=).
  private static readonly ALLOWED = ['aviasales.com', 'hotellook.com', 'booking.com', 'viator.com', 'getyourguide.com', 'airalo.com', 'yesim.app', 'tp.st'];
  private allowedTarget(u: string): boolean {
    try {
      const h = new URL(u).hostname.toLowerCase();
      const ownHost = (() => { try { return new URL(this.config.get<string>('PUBLIC_BASE_URL') || '').hostname.toLowerCase(); } catch { return ''; } })();
      if (ownHost && (h === ownHost || h.endsWith('.' + ownHost))) return true;
      return TravelGoController.ALLOWED.some((d) => h === d || h.endsWith('.' + d));
    } catch { return false; }
  }

  // First-party click tracking for contextual camera offers → CTR by kind/brand.
  @Get('go/offer')
  async goOffer(@Query('k') k: string, @Query('b') b: string, @Query('u') u: string, @Res() res: Response) {
    const kind = ['esim', 'hotels', 'flights', 'experience'].includes(k) ? k : 'other';
    if (!u || !this.allowedTarget(u)) return res.redirect(302, '/');
    await this.travel.bump(kind, (b || '').slice(0, 40), 'clicks'); // await so the write isn't dropped before redirect
    return res.redirect(302, u);
  }

  // CTR dashboard data (admin-token gated).
  @Get('api/travel/offer-stats')
  async offerStats(@Query('key') key?: string) {
    const admin = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN');
    if (!admin || key !== admin) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);
    return this.travel.offerStats();
  }
}
