export interface Destination {
  city?: string | null;
  cc?: string | null;
  iata?: string | null;
  lat: number;
  lng: number;
}

export type TravelBrand = 'viator' | 'getyourguide';

export interface TravelOffer {
  brand: string;
  title: string;
  url: string;
  price?: number;
  currency?: string;
  image?: string;
}

export interface TravelOffersResult {
  destination: Destination;
  experiences: { brand: TravelBrand; label: string; url: string }[]; // primary layer (Viator/GetYourGuide)
  hotels?: { label: string; url: string };                            // supplementary
  flights?: { label: string; url: string; hotPrices?: any[] };        // supplementary + "горящие" prices
  esim?: { brand: string; label: string; url: string }[];             // eSIM affiliate (Airalo/Yesim) by country
  currency: string;
  affiliate: boolean; // true when links are affiliate-wrapped; false = plain brand links (no keys / review mode)
  fetchedAt: string;
}

// What a provider returns: ready-to-use URLs (affiliate-wrapped if configured, else plain brand links).
export interface BuiltOffers {
  experiences: { brand: TravelBrand; url: string }[];
  hotels?: { url: string };
  flights?: { url: string };
  esim?: { brand: 'airalo' | 'yesim'; url: string }[];
  affiliate: boolean;
}

export interface TravelOfferProvider {
  readonly name: string;
  /** Build all offer links for a destination in one shot (batched conversion + cache). */
  buildOffers(
    dest: Destination,
    opts: { brands: TravelBrand[]; locale: string; currency: string; subId: string; originIata?: string },
  ): Promise<BuiltOffers>;
  /** "Горящие" flight prices (cheapest tickets in last 48h) via Data API. */
  fetchHotPrices?(dest: Destination, opts: { originIata?: string; currency: string }): Promise<any[]>;
}
