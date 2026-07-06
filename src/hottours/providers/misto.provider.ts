import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITourProvider, NormalizedTour } from '../hottours.types';
import { countryCodeOf } from '../geo-names';

/**
 * Misto.travel hot-tours feed. Runs ONLY when its key/URL is configured.
 * Expects a JSON feed (array or {tours:[...]}) of package tours; map fields to NormalizedTour.
 * Point HOT_TOURS_MISTO_FEED_URL at the partner export; HOT_TOURS_MISTO_KEY sent as X-API-Key if set.
 */
@Injectable()
export class MistoTravelProvider implements ITourProvider {
  readonly providerId = 'misto';
  private readonly logger = new Logger(MistoTravelProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get feedUrl() { return this.config.get<string>('HOT_TOURS_MISTO_FEED_URL') || ''; }
  private get apiKey() { return this.config.get<string>('HOT_TOURS_MISTO_KEY') || ''; }
  get enabled() { return !!this.feedUrl; }

  async fetchTours(): Promise<NormalizedTour[]> {
    if (!this.enabled) return [];
    try {
      const r = await fetch(this.feedUrl, this.apiKey ? { headers: { 'X-API-Key': this.apiKey } } : undefined);
      if (!r.ok) { this.logger.warn(`Misto feed HTTP ${r.status}`); return []; }
      const j: any = await r.json();
      const rows: any[] = Array.isArray(j) ? j : (j?.tours || j?.data || []);
      return rows.map((t) => this.normalize(t)).filter(Boolean) as NormalizedTour[];
    } catch (e: any) {
      this.logger.warn(`Misto feed error: ${e?.message || e}`);
      return [];
    }
  }

  private normalize(t: any): NormalizedTour | null {
    const country = String(t.country || t.destinationCountry || '').trim();
    const city = String(t.city || t.resort || t.destinationCity || '').trim();
    const price = Number(t.price || t.priceUAH || t.price_uah || 0);
    const link = String(t.link || t.url || t.affiliateDeepLink || t.booking_url || '').trim();
    if (!country || !city || !price || !link) return null;
    return {
      destinationCountry: country,
      destinationCity: city,
      countryCode: t.countryCode || t.cc || countryCodeOf(country),
      destIata: t.iata || t.destIata || null, destCityId: t.cityId || t.locationId || null, originIata: t.fromIata || t.originIata || null,
      hotelName: String(t.hotel || t.hotelName || '').trim() || `Отель в ${city}`,
      hotelStars: Number(t.stars || t.hotelStars || 0),
      boardType: t.board || t.boardType || null,
      departureCity: String(t.from || t.departureCity || '').trim() || 'Київ',
      departureDate: new Date(t.date || t.departureDate || Date.now()).toISOString(),
      nights: Number(t.nights || 7),
      priceUAH: Math.round(price),
      oldPriceUAH: t.oldPrice || t.oldPriceUAH ? Math.round(Number(t.oldPrice || t.oldPriceUAH)) : null,
      operator: t.operator || null,
      affiliateDeepLink: link,
    };
  }
}
