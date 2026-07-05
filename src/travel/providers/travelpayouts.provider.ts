import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BuiltOffers, Destination, TravelBrand, TravelOfferProvider } from '../travel.types';

// cc (ISO-3166 alpha-2) -> country slug used by Airalo (`/<slug>-esim`) and Yesim (`/country/<slug>/`).
// Covers common camera countries; unknown cc falls back to the brand store homepage (still affiliate).
const COUNTRY_SLUG: Record<string, string> = {
  US: 'united-states', GB: 'united-kingdom', UA: 'ukraine', PL: 'poland', DE: 'germany', FR: 'france',
  IT: 'italy', ES: 'spain', PT: 'portugal', NL: 'netherlands', BE: 'belgium', CH: 'switzerland',
  AT: 'austria', CZ: 'czech-republic', SK: 'slovakia', HU: 'hungary', RO: 'romania', BG: 'bulgaria',
  GR: 'greece', HR: 'croatia', RS: 'serbia', SI: 'slovenia', IE: 'ireland', DK: 'denmark', SE: 'sweden',
  NO: 'norway', FI: 'finland', IS: 'iceland', EE: 'estonia', LV: 'latvia', LT: 'lithuania',
  TR: 'turkey', GE: 'georgia', AM: 'armenia', AZ: 'azerbaijan', IL: 'israel', AE: 'united-arab-emirates',
  SA: 'saudi-arabia', QA: 'qatar', EG: 'egypt', MA: 'morocco', TN: 'tunisia', ZA: 'south-africa',
  KE: 'kenya', TZ: 'tanzania', PR: 'puerto-rico',
  JP: 'japan', KR: 'south-korea', CN: 'china', HK: 'hong-kong', TW: 'taiwan', TH: 'thailand',
  VN: 'vietnam', ID: 'indonesia', MY: 'malaysia', SG: 'singapore', PH: 'philippines', IN: 'india',
  LK: 'sri-lanka', NP: 'nepal', KH: 'cambodia', LA: 'laos', MM: 'myanmar',
  AU: 'australia', NZ: 'new-zealand', FJ: 'fiji',
  CA: 'canada', MX: 'mexico', BR: 'brazil', AR: 'argentina', CL: 'chile', PE: 'peru', CO: 'colombia',
  CU: 'cuba', DO: 'dominican-republic', CR: 'costa-rica', PA: 'panama', UY: 'uruguay', BO: 'bolivia', EC: 'ecuador',
};


/**
 * Travelpayouts affiliate provider (ТЗ §8). Start brands: Viator + GetYourGuide.
 *
 * NO hardcoded program/redirect IDs. Plain brand URLs are converted to affiliate links
 * on the fly via the Travelpayouts Partner Links API (POST /links/v1/create), which
 * resolves the brand from the URL itself. We only need: token + marker + trs (project ID)
 * and the programs connected in the Travelpayouts dashboard.
 *
 * Review-friendly: if token/marker/trs are NOT configured, the site still serves working
 * plain brand links (Viator/GetYourGuide/Booking/Aviasales) so it is fully functional for
 * program review. Once keys are set, the same links become affiliate-wrapped automatically.
 *
 * Caching: L1 in-memory (warm invocations) + DB TravelOfferCache (serverless cold starts),
 * TTL = TRAVEL_LINK_TTL_SEC. Batched (<=10 links/request) to respect the 100 req/min limit.
 */
@Injectable()
export class TravelpayoutsProvider implements TravelOfferProvider {
  readonly name = 'travelpayouts';
  private readonly logger = new Logger(TravelpayoutsProvider.name);
  private readonly l1 = new Map<string, { url: string; exp: number }>();

  private static readonly API = 'https://api.travelpayouts.com/links/v1/create';
  private static readonly DATA_API = 'https://api.travelpayouts.com/v2/prices/latest';

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private get marker() { return this.config.get<string>('TRAVELPAYOUTS_MARKER') || ''; }
  private get token() { return this.config.get<string>('TRAVELPAYOUTS_TOKEN') || ''; }
  private get trs() { return this.config.get<string>('TRAVELPAYOUTS_TRS') || ''; }
  private get configured() { return Boolean(this.token && this.marker && this.trs); }
  private get ttlMs() { return (this.config.get<number>('TRAVEL_LINK_TTL_SEC') ?? 2592000) * 1000; }

  // ---- plain, full-length brand URLs (functional fallback; also the input to the Links API) ----
  private q(dest: Destination): string {
    return encodeURIComponent((dest.city || dest.cc || `${dest.lat},${dest.lng}`).trim());
  }
  private brandUrl(kind: 'viator' | 'getyourguide' | 'hotels' | 'flights', dest: Destination, opts: { locale: string; originIata?: string }): string {
    const q = this.q(dest);
    switch (kind) {
      case 'viator':
        return `https://www.viator.com/search/${q}`;
      case 'getyourguide':
        return `https://www.getyourguide.com/s/?q=${q}`;
      case 'hotels':
        return `https://www.booking.com/searchresults.html?ss=${q}`;
      case 'flights': {
        const dst = dest.iata || '';
        const org = opts.originIata || '';
        return dst ? `https://www.aviasales.com/search/${org}${dst}1` : `https://www.aviasales.com/`;
      }
    }
  }

  // eSIM affiliate deep-links (Airalo / Yesim) by destination country; homepage fallback when unknown.
  private get esimBrands(): ('airalo' | 'yesim')[] {
    return ((this.config.get<string>('TRAVEL_ESIM_BRANDS') ?? 'airalo,yesim')
      .split(',').map((s) => s.trim()).filter(Boolean) as ('airalo' | 'yesim')[]);
  }
  private esimUrl(brand: 'airalo' | 'yesim', dest: Destination): string {
    const slug = COUNTRY_SLUG[(dest.cc || '').toUpperCase()];
    if (brand === 'airalo') return slug ? `https://www.airalo.com/${slug}-esim` : 'https://www.airalo.com/';
    return slug ? `https://yesim.app/country/${slug}/` : 'https://yesim.app/';
  }

  async buildOffers(
    dest: Destination,
    opts: { brands: TravelBrand[]; locale: string; currency: string; subId: string; originIata?: string },
  ): Promise<BuiltOffers> {
    // Compose the set of plain links we want, keyed for remapping after conversion.
    const items: { key: string; url: string }[] = [];
    for (const brand of opts.brands) items.push({ key: `exp:${brand}`, url: this.brandUrl(brand, dest, opts) });
    items.push({ key: 'hotels', url: this.brandUrl('hotels', dest, opts) });
    items.push({ key: 'flights', url: this.brandUrl('flights', dest, { ...opts }) });
    const esimBrands = this.esimBrands;
    for (const b of esimBrands) items.push({ key: `esim:${b}`, url: this.esimUrl(b, dest) });

    const converted = await this.convertBatch(items.map((i) => i.url), opts.subId);
    const byKey = new Map(items.map((it, i) => [it.key, converted[i] ?? it.url]));

    return {
      experiences: opts.brands.map((brand) => ({ brand, url: byKey.get(`exp:${brand}`)! })),
      hotels: { url: byKey.get('hotels')! },
      flights: { url: byKey.get('flights')! },
      esim: esimBrands.map((b) => ({ brand: b, url: byKey.get(`esim:${b}`)! })),
      affiliate: this.configured,
    };
  }

  /** Convert arbitrary brand URLs (e.g. Viator Deals feed links) into affiliate links. */
  async toAffiliate(urls: string[], subId: string): Promise<string[]> {
    return this.convertBatch(urls, subId);
  }

  /**
   * Convert brand URLs -> affiliate URLs. Returns an array aligned with input.
   * Any per-link failure / missing config / API error falls back to the plain URL (links always work).
   */
  private async convertBatch(urls: string[], subId: string): Promise<string[]> {
    if (!this.configured) return urls; // review mode — plain working links, no keys required
    const now = Date.now();
    const out: (string | null)[] = new Array(urls.length).fill(null);
    const miss: { idx: number; url: string }[] = [];

    // 1) cache (L1 then DB)
    for (let i = 0; i < urls.length; i++) {
      const ck = this.cacheKey(urls[i], subId);
      const hot = this.l1.get(ck);
      if (hot && hot.exp > now) { out[i] = hot.url; continue; }
      const row = await this.cacheGet(ck);
      if (row && now - row.fetchedAt.getTime() < this.ttlMs) {
        const u = (row.payload as any)?.partnerUrl;
        if (u) { out[i] = u; this.l1.set(ck, { url: u, exp: now + this.ttlMs }); continue; }
      }
      miss.push({ idx: i, url: urls[i] });
    }
    if (miss.length === 0) return out.map((u, i) => u ?? urls[i]);

    // 2) call Partner Links API in chunks of <=10
    try {
      for (let c = 0; c < miss.length; c += 10) {
        const chunk = miss.slice(c, c + 10);
        const body = {
          trs: this.numeric(this.trs),
          marker: this.numeric(this.marker),
          shorten: true,
          links: chunk.map((x) => ({ url: x.url, sub_id: subId })),
        };
        const r = await fetch(TravelpayoutsProvider.API, {
          method: 'POST',
          headers: { 'X-Access-Token': this.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) { this.logger.warn(`Partner Links API HTTP ${r.status} — falling back to plain links`); continue; }
        const j: any = await r.json();
        const links: any[] = j?.result?.links ?? [];
        for (let k = 0; k < chunk.length; k++) {
          const item = links[k];
          if (item?.code === 'success' && item?.partner_url) {
            const idx = chunk[k].idx;
            out[idx] = item.partner_url;
            const ck = this.cacheKey(chunk[k].url, subId);
            this.l1.set(ck, { url: item.partner_url, exp: now + this.ttlMs });
            await this.cacheSet(ck, item.partner_url);
          } else {
            this.logger.warn(`Link convert failed (${item?.message || 'unknown'}): ${chunk[k].url}`);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Partner Links API error: ${String(e)} — falling back to plain links`);
    }

    // 3) plain fallback wherever conversion is missing
    return out.map((u, i) => u ?? urls[i]);
  }

  private numeric(v: string): number | string {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : v;
  }
  private cacheKey(url: string, subId: string): string {
    return 'tplink:' + createHash('sha1').update(`${url}|${subId}|short`).digest('hex');
  }
  private async cacheGet(key: string) {
    try { return await this.prisma.travelOfferCache.findUnique({ where: { key } }); }
    catch { return null; }
  }
  private async cacheSet(key: string, partnerUrl: string) {
    try {
      await this.prisma.travelOfferCache.upsert({
        where: { key },
        create: { key, payload: { partnerUrl } as any, fetchedAt: new Date() },
        update: { payload: { partnerUrl } as any, fetchedAt: new Date() },
      });
    } catch { /* cache is best-effort */ }
  }

  // "Горящие" flight prices via Travelpayouts Data API (cheapest tickets in the last 48h).
  // Read-only data; safe to call without affiliate links configured (needs token only).
  async fetchHotPrices(dest: Destination, opts: { originIata?: string; currency: string }): Promise<any[]> {
    if (!this.token || !dest.iata) return [];
    const params = new URLSearchParams({
      currency: opts.currency.toLowerCase(),
      destination: dest.iata,
      show_to_affiliates: 'true',
      sorting: 'price',
      limit: '5',
    });
    if (opts.originIata) params.set('origin', opts.originIata);
    try {
      const r = await fetch(`${TravelpayoutsProvider.DATA_API}?${params.toString()}`, {
        headers: { 'X-Access-Token': this.token },
      });
      if (!r.ok) { this.logger.warn(`Data API HTTP ${r.status}`); return []; }
      const j: any = await r.json();
      return Array.isArray(j?.data) ? j.data : [];
    } catch (e) {
      this.logger.warn(`Data API error: ${String(e)}`);
      return [];
    }
  }
}
