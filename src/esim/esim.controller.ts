import { Body, Controller, Get, Headers, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EsimService } from './esim.service';

/**
 * Read path (packages, cheapest-for-country) is public for the storefront UI.
 * Write path (order/topup) and usage lookups are guarded by ADMIN_API_KEY — a real checkout
 * belongs behind a payment step (PSP) and is out of scope for this scaffold.
 */
@Controller('api/esim')
export class EsimController {
  constructor(private readonly esim: EsimService, private readonly config: ConfigService) {}

  private assertAdmin(key?: string) {
    const expected = this.config.get<string>('ADMIN_API_KEY');
    if (!expected || key !== expected) throw new UnauthorizedException('bad admin key');
  }

  @Get('packages')
  async packages(@Query('country') country?: string, @Query('scope') scope?: string, @Query('limit') limit?: string) {
    const items = await this.esim.listPackages({
      country,
      scope: scope as any,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { enabled: this.esim.enabled, items };
  }

  @Get('cheapest')
  async cheapest(@Query('country') country: string) {
    const pkg = await this.esim.cheapestForCountry(country);
    return { enabled: this.esim.enabled, package: pkg };
  }

  @Get(':iccid/usage')
  async usage(@Param('iccid') iccid: string, @Headers('x-admin-key') key?: string) {
    this.assertAdmin(key);
    return this.esim.getUsage(iccid);
  }

  @Post('order')
  async order(@Body() body: { packageId: string; quantity?: number; reference?: string; email?: string }, @Headers('x-admin-key') key?: string) {
    this.assertAdmin(key);
    return this.esim.orderPackage(body);
  }

  @Post('topup')
  async topup(@Body() body: { iccid: string; packageId: string; reference?: string }, @Headers('x-admin-key') key?: string) {
    this.assertAdmin(key);
    return this.esim.topUp(body);
  }
}
