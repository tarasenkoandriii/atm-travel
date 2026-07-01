import { Controller, Get, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { I18nService } from '../i18n/i18n.service';
import { SnapshotService } from '../cameras/snapshot.service';

// Runtime config injected into the static front-end (ТЗ §11). No API keys are exposed.
@Controller()
export class BootstrapController {
  constructor(
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
    private readonly snapshot: SnapshotService,
  ) {}

  @Get('bootstrap')
  async bootstrap(@Req() req: Request) {
    const locale = this.i18n.resolveLocale(req);
    const snap = await this.snapshot.get();
    const brands = this.config.get<string>('TRAVEL_PRIMARY_BRANDS')!.split(',').map((s) => s.trim());
    return {
      apiBase: '/api',
      version: '1.6.0',
      brand: 'ATM-travel.org',
      locale,
      availableLocales: this.i18n.supported,
      dictionary: this.i18n.dictionary(locale),
      lastRefreshAt: snap?.builtAt ?? null,
      counts: { total: snap?.count ?? 0 },
      cycleMs: 25000,
      weather: {
        enabled: !!this.config.get<string>('WEATHERAPI_KEY'),
        provider: 'weatherapi',
        forecastDays: this.config.get<number>('WEATHER_FORECAST_DAYS'),
        units: this.config.get<string>('WEATHER_UNITS'),
        attribution: 'Powered by WeatherAPI.com',
      },
      deals: {
        enabled: !!this.config.get<string>('VIATOR_DEALS_FEED_URL'),
      },
      esim: {
        enabled: !!(this.config.get<string>('AIRALO_CLIENT_ID') && this.config.get<string>('AIRALO_CLIENT_SECRET')),
        // Full purchase requires BOTH the eSIM provider AND the payment gateway.
        canBuy: !!(
          this.config.get<string>('AIRALO_CLIENT_ID') &&
          this.config.get<string>('AIRALO_CLIENT_SECRET') &&
          this.config.get<string>('WFP_MERCHANT_ACCOUNT') &&
          this.config.get<string>('WFP_SECRET_KEY')
        ),
        checkoutUrl: this.config.get<string>('ESIM_CHECKOUT_URL') || '/esim',
        checkout: {
          enabled: !!(this.config.get<string>('WFP_MERCHANT_ACCOUNT') && this.config.get<string>('WFP_SECRET_KEY')),
          currency: this.config.get<string>('WFP_CURRENCY') || 'USD',
          googleClientId: this.config.get<string>('GOOGLE_CLIENT_ID') || '',
        },
      },
      travel: {
        enabled: true, // links always work (plain brand links if keys absent — keeps site functional for review)
        affiliate: !!(
          this.config.get<string>('TRAVELPAYOUTS_TOKEN') &&
          this.config.get<string>('TRAVELPAYOUTS_MARKER') &&
          this.config.get<string>('TRAVELPAYOUTS_TRS')
        ),
        provider: 'travelpayouts',
        primaryBrands: brands,
        currency: this.config.get<string>('TRAVEL_DEFAULT_CURRENCY'),
      },
      flags: { tma: false },
    };
  }
}
