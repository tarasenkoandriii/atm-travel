import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CamerasRepository } from '../cameras/cameras.repository';
import { DestinationResolver } from './destination.resolver';
import { TravelpayoutsProvider } from './providers/travelpayouts.provider';
import { Destination, TravelBrand, TravelOffersResult } from './travel.types';
import { I18nService } from '../i18n/i18n.service';

@Injectable()
export class TravelService {
  constructor(
    private readonly config: ConfigService,
    private readonly resolver: DestinationResolver,
    private readonly provider: TravelpayoutsProvider,
    private readonly cameras: CamerasRepository,
    private readonly i18n: I18nService,
  ) {}

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
    const experiences = built.experiences.map((e) => ({ brand: e.brand, label: brandLabel(e.brand), url: e.url }));

    const hotPrices = await this.provider.fetchHotPrices(dest, { originIata: args.originIata, currency });

    return {
      destination: dest,
      experiences,
      hotels: built.hotels ? { label: labels['hotels'] ?? 'Hotels', url: built.hotels.url } : undefined,
      flights: built.flights
        ? { label: labels['flights'] ?? 'Flights', url: built.flights.url, hotPrices }
        : undefined,
      esim: built.esim?.length
        ? built.esim.map((e) => ({ brand: e.brand, label: e.brand === 'airalo' ? 'Airalo eSIM' : 'Yesim eSIM', url: e.url }))
        : undefined,
      currency,
      affiliate: built.affiliate,
      fetchedAt: new Date().toISOString(),
    };
  }
}
