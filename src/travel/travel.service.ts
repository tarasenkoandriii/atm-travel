import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CamerasRepository } from '../cameras/cameras.repository';
import { DestinationResolver } from './destination.resolver';
import { TravelpayoutsProvider } from './providers/travelpayouts.provider';
import { Destination, TravelBrand, TravelOffersResult } from './travel.types';
import { I18nService } from '../i18n/i18n.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TravelService {
  constructor(
    private readonly config: ConfigService,
    private readonly resolver: DestinationResolver,
    private readonly provider: TravelpayoutsProvider,
    private readonly cameras: CamerasRepository,
    private readonly i18n: I18nService,
    private readonly prisma: PrismaService,
  ) {}

  private get baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || 'https://atm-travel.org').replace(/\/$/, ''); }

  // First-party tracking redirect for a contextual offer: logs the click, then 302 to the affiliate URL.
  private wrapGo(kind: string, brand: string, url: string, cam?: string): string {
    if (!url) return url;
    const c = cam ? `&cam=${encodeURIComponent(cam)}` : '';
    return `${this.baseUrl}/go/offer?k=${encodeURIComponent(kind)}&b=${encodeURIComponent(brand)}${c}&u=${encodeURIComponent(url)}`;
  }

  private today() { return new Date().toISOString().slice(0, 10); }
  async bump(kind: string, brand: string, field: 'impressions' | 'clicks', n = 1) {
    try {
      await this.prisma.offerStat.upsert({
        where: { day_kind_brand: { day: this.today(), kind, brand: brand || '' } },
        create: { day: this.today(), kind, brand: brand || '', impressions: field === 'impressions' ? n : 0, clicks: field === 'clicks' ? n : 0 },
        update: { [field]: { increment: n } } as any,
      });
    } catch { /* analytics is best-effort */ }
  }

  // Aggregate CTR by kind (+ click breakdown by brand) for the admin dashboard.
  async offerStats(): Promise<any> {
    const rows = await this.prisma.offerStat.findMany().catch(() => [] as any[]);
    const byKind: Record<string, { impressions: number; clicks: number }> = {};
    const byBrand: Record<string, { kind: string; brand: string; clicks: number }> = {};
    for (const r of rows) {
      (byKind[r.kind] ??= { impressions: 0, clicks: 0 });
      byKind[r.kind].impressions += r.impressions; byKind[r.kind].clicks += r.clicks;
      if (r.brand) { const k = `${r.kind}/${r.brand}`; (byBrand[k] ??= { kind: r.kind, brand: r.brand, clicks: 0 }); byBrand[k].clicks += r.clicks; }
    }
    const kinds = Object.entries(byKind).map(([kind, v]) => ({ kind, impressions: v.impressions, clicks: v.clicks, ctr: v.impressions ? Math.round((v.clicks / v.impressions) * 1000) / 10 : 0 }))
      .sort((a, b) => b.impressions - a.impressions);
    const brands = Object.values(byBrand).sort((a, b) => b.clicks - a.clicks);
    return { kinds, brands, updatedAt: new Date().toISOString() };
  }

  private brands(): TravelBrand[] {
    return this.config
      .get<string>('TRAVEL_PRIMARY_BRANDS')!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as TravelBrand[];
  }

  async offers(args: {
    cameraId?: string; lat?: number; lng?: number; locale: string; currency?: string; originIata?: string;
  }): Promise<TravelOffersResult> {
    let dest: Destination;
    if (args.cameraId) {
      const cam = await this.cameras.findById(args.cameraId);
      dest = cam ? this.resolver.fromCamera(cam) : this.resolver.fromLatLng(args.lat ?? 0, args.lng ?? 0);
    } else {
      dest = this.resolver.fromLatLng(args.lat ?? 0, args.lng ?? 0);
    }

    const currency = (args.currency || this.config.get<string>('TRAVEL_DEFAULT_CURRENCY')!).toUpperCase();
    const subId = args.cameraId || `${dest.lat},${dest.lng}`;
    const labels = this.i18n.dictionary(args.locale).travel || {};
    const brands = this.brands();

    // One batched call → affiliate-wrapped links if configured, else plain working brand links.
    const built = await this.provider.buildOffers(dest, {
      brands, locale: args.locale, currency, subId, originIata: args.originIata,
    });

    const brandLabel = (b: TravelBrand) => (b === 'viator' ? 'Viator' : 'GetYourGuide');
    const cam = args.cameraId;
    const experiences = built.experiences.map((e) => ({ brand: e.brand, label: brandLabel(e.brand), url: this.wrapGo('experience', e.brand, e.url, cam) }));

    const hotPrices = await this.provider.fetchHotPrices(dest, { originIata: args.originIata, currency });

    const hotels = built.hotels ? { label: labels['hotels'] ?? 'Hotels', url: this.wrapGo('hotels', 'booking', built.hotels.url, cam) } : undefined;
    const flights = built.flights ? { label: labels['flights'] ?? 'Flights', url: this.wrapGo('flights', 'aviasales', built.flights.url, cam), hotPrices } : undefined;
    const esim = built.esim?.length
      ? built.esim.map((e) => ({ brand: e.brand, label: e.brand === 'airalo' ? 'Airalo eSIM' : 'Yesim eSIM', url: this.wrapGo('esim', e.brand, e.url, cam) }))
      : undefined;

    // Log impressions per kind shown (best-effort, non-blocking) → CTR denominator.
    const shown = new Set<string>();
    if (experiences.length) shown.add('experience');
    if (hotels) shown.add('hotels');
    if (flights) shown.add('flights');
    if (esim?.length) shown.add('esim');
    for (const k of shown) void this.bump(k, '', 'impressions');

    return {
      destination: dest,
      experiences,
      hotels,
      flights,
      esim,
      currency,
      affiliate: built.affiliate,
      fetchedAt: new Date().toISOString(),
    };
  }
}
