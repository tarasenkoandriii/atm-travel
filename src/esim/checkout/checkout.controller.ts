import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service';
import { WfpCallback } from './wayforpay.service';

@Controller('api/esim')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('checkout/create')
  create(@Body() body: { packageId: string; country: string; email?: string }) {
    return this.checkout.create(body);
  }

  // WayForPay serviceUrl. Body may arrive as JSON or as a form field containing JSON — normalize both.
  @Post('checkout/callback')
  async callback(@Req() req: Request) {
    const cb = this.normalize(req.body);
    return this.checkout.handleCallback(cb);
  }

  @Get('checkout/status')
  status(@Query('ref') ref: string) {
    return this.checkout.status(ref);
  }

  @Post('auth/google')
  google(@Body() body: { idToken: string }) {
    return this.checkout.verifyGoogle(body?.idToken);
  }

  private normalize(body: any): WfpCallback {
    if (body && typeof body === 'object' && body.orderReference) return body as WfpCallback;
    // urlencoded form where the whole JSON is a single key
    if (body && typeof body === 'object') {
      const keys = Object.keys(body);
      if (keys.length === 1) {
        try { return JSON.parse(keys[0]); } catch { /* fallthrough */ }
        try { return JSON.parse(body[keys[0]]); } catch { /* fallthrough */ }
      }
    }
    if (typeof body === 'string') { try { return JSON.parse(body); } catch { /* ignore */ } }
    return (body || {}) as WfpCallback;
  }
}
