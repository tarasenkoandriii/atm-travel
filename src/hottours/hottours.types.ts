// Framework-agnostic core for the hot-tours ingestion. Concrete feed adapters live in ./providers,
// registered under TOUR_PROVIDERS. A provider only runs when its own env keys are present.

export const TOUR_PROVIDERS = Symbol('TOUR_PROVIDERS');

export interface NormalizedTour {
  destinationCountry: string;
  destinationCity: string;
  countryCode?: string | null; // ISO alpha-2 for the flag
  destIata?: string | null;    // strict destination id (IATA)
  destCityId?: string | null;  // Hotellook location id
  originIata?: string | null;  // strict departure id (IATA)
  hotelName: string;
  hotelStars: number;
  boardType?: string | null;
  departureCity: string;
  departureDate: string; // ISO date
  nights: number;
  priceUAH: number;
  oldPriceUAH?: number | null;
  operator?: string | null;
  affiliateDeepLink: string;
}

export interface ITourProvider {
  readonly providerId: string;
  /** True only when this feed's credentials are configured — the cron skips disabled feeds. */
  readonly enabled: boolean;
  /** Pull the current hot tours from the feed (already normalized). */
  fetchTours(): Promise<NormalizedTour[]>;
}
