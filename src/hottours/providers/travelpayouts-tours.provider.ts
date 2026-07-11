import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITourProvider, NormalizedTour } from '../hottours.types';
import { countryCodeOf } from '../geo-names';
import { IATA } from '../iata';

/**
 * Travelpayouts feed. Travelpayouts has NO package-tour feed, so this provider supports several modes
 * (priority: custom feed → discounts → hotels → flights); each runs only when its keys are present:
 *
 *  A) HOT_TOURS_TP_FEED_URL set  → custom package-tour export from a TP program (generic JSON map).
 *  D) HOT_TOURS_TP_DISCOUNTS=1   → Hotellook Selections (yasen.hotellook.com widget_location_dump):
 *                                  hotels WITH a real last_price_info.discount → pages show "−N%".
 *  C) HOT_TOURS_TP_HOTELS=1      → Hotellook cache.json — hotels-by-location "from" price (no discount).
 *  B) HOT_TOURS_TP_FLIGHTS=1     → Aviasales Flight Data (cheapest tickets / popular directions).
 *
 * Package tours proper are best sourced from Misto.
 */
@Injectable()
export class TravelpayoutsToursProvider implements ITourProvider {
  readonly providerId = 'travelpayouts';
  private readonly logger = new Logger(TravelpayoutsToursProvider.name);
  private static readonly V3 = 'https://api.travelpayouts.com/aviasales/v3';

  constructor(private readonly config: ConfigService) {}

  private get token() { return this.config.get<string>('TRAVELPAYOUTS_TOKEN') || ''; }
  private get marker() { return this.config.get<string>('TRAVELPAYOUTS_MARKER') || ''; }
  private get feedUrl() { return this.config.get<string>('HOT_TOURS_TP_FEED_URL') || ''; }
  private get discounts() { const v = this.config.get<string>('HOT_TOURS_TP_DISCOUNTS'); return v === '1' || v === 'true'; }
  private get selection() { return this.config.get<string>('HOT_TOURS_TP_SELECTION') || 'popularity'; }
  private get hotels() { const v = this.config.get<string>('HOT_TOURS_TP_HOTELS'); return v === '1' || v === 'true'; }
  private get flights() { const v = this.config.get<string>('HOT_TOURS_TP_FLIGHTS'); return v === '1' || v === 'true'; }
  // Multiple origins, comma-separated (same convention as `locations` below) — Ukrainian airspace
  // has been closed since Feb 2022, so a single Kyiv origin returns nothing; the realistic origins
  // for this site are neighboring-country hub airports Ukrainians travel to by land (Poland/Hungary/
  // Romania). fromFlightDeals() queries get_popular_directions once per origin and merges results.
  private get origins() {
    return (this.config.get<string>('HOT_TOURS_TP_ORIGIN') || '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  // Multiple departure-city labels, comma-separated (same convention as origins/locations) — cycled
  // round-robin across generated rows in modes C/D (Hotellook doesn't search flights, so this is a
  // display/content label, not an API parameter) so realistic variety appears across the pool —
  // some tours say "from Warsaw", others "from Budapest" — instead of every single one claiming the
  // exact same departure city regardless of which neighboring hub is actually configured.
  private get departures() {
    return (this.config.get<string>('HOT_TOURS_TP_DEPARTURE') || 'Київ')
      .split(',').map((s) => s.trim()).filter(Boolean);
  }
  private departureAt(i: number): string {
    const d = this.departures;
    return d[i % d.length] || 'Київ';
  }
  private get locations() {
    return (this.config.get<string>('HOT_TOURS_TP_LOCATIONS') ||
      'AYT,HRG,SSH,HER,RHO,LCA,DXB,HKT,BJV,DLM,AGP,PMI,TFS,BOJ,VAR,TIV,DJE,ZNZ,PUJ,CUN')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  private readonly cityIdCache = new Map<string, number>();

  // Departure-city label → IATA (for the strict origin id on hotel/tour rows). Accepts an explicit
  // name (the specific departureAt(i) assigned to THIS row) so multi-departure cycling resolves the
  // correct IATA per row instead of always the first configured city.
  private depIata(name?: string): string | null {
    const m: Record<string, string> = {
      'київ': 'IEV', 'киев': 'IEV', 'kyiv': 'IEV', 'kiev': 'IEV', 'львів': 'LWO', 'львов': 'LWO',
      'варшава': 'WAW', 'warsaw': 'WAW', 'краків': 'KRK', 'краков': 'KRK', 'krakow': 'KRK', 'жешув': 'RZE', 'rzeszow': 'RZE', 'rzeszów': 'RZE',
      'будапешт': 'BUD', 'budapest': 'BUD', 'дебрецен': 'DEB', 'debrecen': 'DEB',
      'бухарест': 'OTP', 'bucharest': 'OTP', 'яссы': 'IAS', 'iasi': 'IAS', 'iași': 'IAS',
      'кишинів': 'KIV', 'кишинев': 'KIV', 'chisinau': 'KIV', 'рига': 'RIX', 'riga': 'RIX',
    };
    const key = (name ?? this.departures[0] ?? '').trim().toLowerCase();
    return m[key] || (this.origins[0] || null);
  }

  get enabled() {
    if (this.feedUrl) return !!(this.token && this.marker);        // custom package feed
    if (this.discounts) return !!(this.token && this.marker);      // Hotellook selections (real −discount%)
    if (this.hotels) return !!(this.token && this.marker);         // Hotellook hotel prices (from-price list)
    return this.flights && !!(this.token && this.marker);          // Aviasales flight deals (opt-in)
  }

  async fetchTours(): Promise<NormalizedTour[]> {
    if (!this.enabled) return [];
    if (this.feedUrl) return this.fromCustomFeed();
    if (this.discounts) return this.fromDiscounts();
    if (this.hotels) return this.fromHotels();
    return this.fromFlightDeals();
  }

  // Which of the 4 mutually-exclusive modes is active right now, and the actual env config behind
  // it — for the "Travelpayouts" admin tab, so this is visible without reading Vercel env vars or
  // this file's source. Secrets (token/marker, and the feed URL which may embed one) are masked.
  private mask(s: string): string {
    if (!s) return '';
    return s.length <= 8 ? '••••' : s.slice(0, 4) + '••••' + s.slice(-4);
  }
  describeStatus(): {
    mode: 'A' | 'B' | 'C' | 'D' | 'none'; modeLabel: string; enabled: boolean;
    env: Record<string, { value: string; set: boolean }>;
  } {
    let mode: 'A' | 'B' | 'C' | 'D' | 'none' = 'none';
    let modeLabel = 'Ничего не настроено — ни одна из переменных режима не задана, провайдер выключен (fetchTours всегда вернёт []).';
    if (this.feedUrl) {
      mode = 'A';
      modeLabel = 'Режим A — кастомный фид пакетных туров (HOT_TOURS_TP_FEED_URL): готовые пакетные предложения от партнёрской программы Travelpayouts, разбираются как есть (normalize()). Приоритет выше остальных режимов.';
    } else if (this.discounts) {
      mode = 'D';
      modeLabel = 'Режим D — Hotellook Selections (HOT_TOURS_TP_DISCOUNTS=1): отели БЕРУТСЯ ТОЛЬКО с реальной скидкой (last_price_info.discount > 0) — на страницах честно показывается «−N%».';
    } else if (this.hotels) {
      mode = 'C';
      modeLabel = 'Режим C — Hotellook Hotels (HOT_TOURS_TP_HOTELS=1): цена «от» по кэшу отелей, БЕЗ проверки скидки — discountPct будет 0 у всех туров этого режима. Правило "любой TP-тур = горящий" (без порога % / звёзд) всё равно применяется при генерации статей.';
    } else if (this.flights) {
      mode = 'B';
      modeLabel = 'Режим B — Aviasales Flight Data (HOT_TOURS_TP_FLIGHTS=1): популярные направления от каждого города в HOT_TOURS_TP_ORIGIN (через запятую — можно несколько сразу, get_popular_directions на каждый), либо просто самые дешёвые билеты за последние 48ч (get_latest_prices), если ORIGIN не задан. Это билеты, не пакетные туры — hotelName/stars будут пустыми. Украина закрыта для гражданских рейсов с 2022 — используйте хабы соседних стран (Польша/Венгрия/Румыния), не украинские аэропорты.';
    }
    return {
      mode, modeLabel, enabled: this.enabled,
      env: {
        TRAVELPAYOUTS_TOKEN: { value: this.mask(this.token), set: !!this.token },
        TRAVELPAYOUTS_MARKER: { value: this.mask(this.marker), set: !!this.marker },
        HOT_TOURS_TP_FEED_URL: { value: this.feedUrl ? this.mask(this.feedUrl) : '', set: !!this.feedUrl },
        HOT_TOURS_TP_DISCOUNTS: { value: this.discounts ? '1' : '(не задано)', set: this.discounts },
        HOT_TOURS_TP_SELECTION: { value: this.selection, set: !!this.config.get<string>('HOT_TOURS_TP_SELECTION') },
        HOT_TOURS_TP_HOTELS: { value: this.hotels ? '1' : '(не задано)', set: this.hotels },
        HOT_TOURS_TP_FLIGHTS: { value: this.flights ? '1' : '(не задано)', set: this.flights },
        HOT_TOURS_TP_ORIGIN: { value: this.origins.length ? this.origins.join(', ') : '(не задано)', set: this.origins.length > 0 },
        HOT_TOURS_TP_DEPARTURE: { value: this.departures.join(', '), set: !!this.config.get<string>('HOT_TOURS_TP_DEPARTURE') },
        HOT_TOURS_TP_LOCATIONS: { value: this.locations.join(', '), set: !!this.config.get<string>('HOT_TOURS_TP_LOCATIONS') },
      },
    };
  }

  // Per-location diagnostics from the LAST fromDiscounts()/fromHotels() run — surfaced by the admin
  // "запустить сейчас" button so "why zero" is answerable without digging through Vercel logs: was
  // the cityId resolved, did the HTTP call succeed, how many hotels came back BEFORE the discount
  // filter, and how many survived it. A location returning rawCount>0 but keptCount=0 means the
  // Hotellook collection for that city/type genuinely had no discounted hotels right now — not a
  // config error; a location with cityId=null means resolveCityId() itself failed for that IATA code.
  // `raw` (first location only, to keep payload small) is the actual response BODY TEXT whenever the
  // parsed result was empty — Hotellook's Hotels-brand program was reported closed by Travelpayouts'
  // own FAQ (Oct 2025: "Widgets, landing pages, and the Hotellook API will stop working"); it's
  // unconfirmed whether that includes this specific Data API vs only their consumer-facing White
  // Label widgets, so seeing the literal response body (an error page, a deprecation notice, or a
  // genuinely valid `{}`) settles it directly instead of guessing further.
  private lastDiagnostics: { loc: string; cityId: number | null; httpStatus: number | null; rawCount: number; keptCount: number; error?: string; raw?: string }[] = [];
  getLastDiagnostics() { return this.lastDiagnostics; }

  // ── Mode D (preferred): Hotellook Selections — real hotel deals WITH a discount %. ──
  // widget_location_dump.json returns hotels with last_price_info{price, old_price, discount, nights};
  // we keep only entries that actually carry a discount, so pages show a real "−N%".
  private async fromDiscounts(): Promise<NormalizedTour[]> {
    const nights = 7;
    const checkIn = new Date(Date.now() + 30 * 864e5);
    const checkOut = new Date(Date.now() + (30 + nights) * 864e5);
    const ci = checkIn.toISOString().slice(0, 10), co = checkOut.toISOString().slice(0, 10);
    const out: NormalizedTour[] = [];
    this.lastDiagnostics = [];
    for (const loc of this.locations.slice(0, 20)) {
      const diag = { loc, cityId: null as number | null, httpStatus: null as number | null, rawCount: 0, keptCount: 0, error: undefined as string | undefined, raw: undefined as string | undefined };
      const cityId = await this.resolveCityId(loc);
      diag.cityId = cityId;
      if (!cityId) { diag.error = 'cityId не резолвится (Hotellook lookup.json не нашёл город)'; this.logger.warn(`Hotellook: no cityId for ${loc}`); this.lastDiagnostics.push(diag); continue; }
      try {
        const url = `https://yasen.hotellook.com/tp/public/widget_location_dump.json?currency=uah&language=ru&limit=8` +
          `&id=${cityId}&type=${encodeURIComponent(this.selection)}&check_in=${ci}&check_out=${co}&token=${encodeURIComponent(this.token)}`;
        const r = await fetch(url);
        diag.httpStatus = r.status;
        const bodyText = await r.text();
        if (!r.ok) {
          diag.error = `HTTP ${r.status}`;
          if (this.lastDiagnostics.length === 0) diag.raw = bodyText.slice(0, 500);
          this.logger.warn(`Hotellook dump ${loc} HTTP ${r.status}`); this.lastDiagnostics.push(diag); continue;
        }
        let j: any = {};
        try { j = JSON.parse(bodyText); } catch { diag.error = 'ответ не JSON'; if (this.lastDiagnostics.length === 0) diag.raw = bodyText.slice(0, 500); this.lastDiagnostics.push(diag); continue; }
        const arr: any[] = Array.isArray(j?.[this.selection]) ? j[this.selection] : (Array.isArray(j) ? j : []);
        diag.rawCount = arr.length;
        if (arr.length === 0 && this.lastDiagnostics.length === 0) diag.raw = bodyText.slice(0, 500);
        for (const h of arr) {
          const lpi = h.last_price_info || {};
          const price = Math.round(Number(lpi.price || 0));
          const oldPrice = Math.round(Number(lpi.old_price || 0));
          if (!price || Number(lpi.discount || 0) <= 0) continue;  // only real discounts
          diag.keptCount++;
          out.push({
            destinationCountry: IATA[loc]?.country || '', destinationCity: IATA[loc]?.city || loc,
            countryCode: IATA[loc]?.cc || null,
            destIata: loc, destCityId: String(cityId), originIata: this.depIata(this.departureAt(out.length)),
            hotelName: String(h.name || ''), hotelStars: Number(h.stars || 0), boardType: null,
            departureCity: this.departureAt(out.length), departureDate: checkIn.toISOString(),
            nights: Number(lpi.nights || nights),
            priceUAH: price, oldPriceUAH: oldPrice > price ? oldPrice : null, operator: 'Hotellook',
            affiliateDeepLink: `https://search.hotellook.com/?marker=${encodeURIComponent(this.marker)}&hotelId=${h.hotel_id}&language=ru`,
          });
        }
      } catch (e: any) { diag.error = e?.message || String(e); this.logger.warn(`Hotellook dump ${loc} error: ${e?.message || e}`); }
      this.lastDiagnostics.push(diag);
    }
    return out;
  }

  // Resolve a Hotellook location id: from the IATA map when known, else via lookup.json (cached).
  private async resolveCityId(loc: string): Promise<number | null> {
    if (IATA[loc]?.cityId) return IATA[loc]!.cityId!;
    if (this.cityIdCache.has(loc)) return this.cityIdCache.get(loc)!;
    try {
      const q = IATA[loc]?.city || loc;
      const r = await fetch(`https://engine.hotellook.com/api/v2/lookup.json?query=${encodeURIComponent(q)}&lang=ru&lookFor=city&limit=1&token=${encodeURIComponent(this.token)}`);
      if (r.ok) {
        const j: any = await r.json();
        const id = Number(j?.results?.locations?.[0]?.id);
        if (id > 0) { this.cityIdCache.set(loc, id); return id; }
      } else this.logger.warn(`Hotellook lookup ${loc} HTTP ${r.status}`);
    } catch (e: any) { this.logger.warn(`Hotellook lookup ${loc} error: ${e?.message || e}`); }
    return null;
  }

  // ── Mode C: Hotellook Hotels Data API — real hotels-by-location list with stars+price. ──
  // For each destination IATA/city → cache.json returns cached room prices per hotel category.
  private async fromHotels(): Promise<NormalizedTour[]> {
    const nights = 7;
    const checkIn = new Date(Date.now() + 30 * 864e5);
    const checkOut = new Date(Date.now() + (30 + nights) * 864e5);
    const ci = checkIn.toISOString().slice(0, 10), co = checkOut.toISOString().slice(0, 10);
    const out: NormalizedTour[] = [];
    this.lastDiagnostics = [];
    for (const loc of this.locations.slice(0, 20)) {
      const diag = { loc, cityId: null as number | null, httpStatus: null as number | null, rawCount: 0, keptCount: 0, error: undefined as string | undefined, raw: undefined as string | undefined };
      try {
        const url = `https://engine.hotellook.com/api/v2/cache.json?location=${encodeURIComponent(loc)}` +
          `&checkIn=${ci}&checkOut=${co}&currency=uah&limit=6&token=${encodeURIComponent(this.token)}`;
        const r = await fetch(url);
        diag.httpStatus = r.status;
        const bodyText = await r.text();
        if (!r.ok) { diag.error = `HTTP ${r.status}`; if (this.lastDiagnostics.length === 0) diag.raw = bodyText.slice(0, 500); this.logger.warn(`Hotellook cache ${loc} HTTP ${r.status}`); this.lastDiagnostics.push(diag); continue; }
        let j: any = {};
        try { j = JSON.parse(bodyText); } catch { diag.error = 'ответ не JSON'; if (this.lastDiagnostics.length === 0) diag.raw = bodyText.slice(0, 500); this.lastDiagnostics.push(diag); continue; }
        const arr: any[] = Array.isArray(j) ? j : (j && j.hotelName ? [j] : []);
        diag.rawCount = arr.length;
        if (arr.length === 0 && this.lastDiagnostics.length === 0) diag.raw = bodyText.slice(0, 500);
        for (const h of arr) {
          const price = Math.round(Number(h.priceFrom || h.priceAvg || 0));
          if (!price || !h.hotelName) continue;
          diag.keptCount++;
          out.push({
            destinationCountry: IATA[loc]?.country || h?.location?.country || '',
            destinationCity: IATA[loc]?.city || h?.location?.name || loc,
            countryCode: IATA[loc]?.cc || countryCodeOf(h?.location?.country || '') || null,
            destIata: loc, destCityId: IATA[loc]?.cityId ? String(IATA[loc]!.cityId) : (h?.locationId ? String(h.locationId) : null), originIata: this.depIata(this.departureAt(out.length)),
            hotelName: String(h.hotelName), hotelStars: Number(h.stars || 0), boardType: null,
            departureCity: this.departureAt(out.length), departureDate: checkIn.toISOString(), nights,
            priceUAH: price, oldPriceUAH: null, operator: 'Hotellook',
            affiliateDeepLink: `https://search.hotellook.com/?marker=${encodeURIComponent(this.marker)}&hotelId=${h.hotelId}&language=ru`,
          });
        }
      } catch (e: any) { diag.error = e?.message || String(e); this.logger.warn(`Hotellook cache ${loc} error: ${e?.message || e}`); }
      this.lastDiagnostics.push(diag);
    }
    return out;
  }

  // ── Mode B: real Travelpayouts Flight Data API (Aviasales v3) ──
  // With an origin hub → get_popular_directions (curated popular resort directions from that city).
  // Otherwise / on empty → get_latest_prices (cheapest tickets found in the last 48h).
  private async fromFlightDeals(): Promise<NormalizedTour[]> {
    const cur = 'uah';
    const headers = { 'X-Access-Token': this.token };
    // Sanity cap, not a rate-limit workaround — the Data API has no request-rate restriction
    // (confirmed in Travelpayouts' own FAQ), this just avoids an admin accidentally listing 50
    // origins and making that many sequential requests for no practical benefit.
    const origins = this.origins.slice(0, 8);
    try {
      let rows: any[] = [];
      for (const o of origins) {
        const r = await fetch(`${TravelpayoutsToursProvider.V3}/get_popular_directions?origin=${encodeURIComponent(o)}&currency=${cur}`, { headers });
        if (r.ok) { const j: any = await r.json(); if (j?.success && j.data) rows.push(...Object.values(j.data)); }
        else this.logger.warn(`TP get_popular_directions(${o}) HTTP ${r.status}`);
      }
      if (!rows.length) {
        // No origins configured (or none of them returned anything) — fall back to the global
        // cheapest-tickets-in-48h feed, optionally still scoped to the first configured origin.
        const p = new URLSearchParams({ currency: cur, period_type: 'year', page: '1', limit: '30', show_to_affiliates: 'true', sorting: 'price', trip_class: '0' });
        if (origins[0]) p.set('origin', origins[0]);
        const r = await fetch(`${TravelpayoutsToursProvider.V3}/get_latest_prices?${p.toString()}`, { headers });
        if (r.ok) { const j: any = await r.json(); if (j?.success && Array.isArray(j.data)) rows = j.data; }
        else this.logger.warn(`TP get_latest_prices HTTP ${r.status}`);
      }
      const out: NormalizedTour[] = [];
      for (const d of rows) {
        const dst = IATA[String(d.destination || '').toUpperCase()];
        if (!dst) continue;                                        // unknown destination — skip
        const price = Math.round(Number(d.value ?? d.price ?? 0));
        if (!price) continue;
        const dep = d.depart_date || d.departure_at || d.found_at || new Date().toISOString();
        const ret = d.return_date || d.return_at || null;
        const nights = ret ? Math.max(1, Math.round((+new Date(ret) - +new Date(dep)) / 864e5)) : 7;
        // Each get_popular_directions row already carries its own "origin" field — this is what lets
        // results from DIFFERENT configured origins stay correctly attributed after being merged
        // into one array above, rather than all defaulting to the same departure city.
        const originIata = String(d.origin || origins[0] || '').toUpperCase();
        out.push({
          destinationCountry: dst.country, destinationCity: dst.city, countryCode: dst.cc,
          destIata: String(d.destination || '').toUpperCase(), destCityId: IATA[String(d.destination || '').toUpperCase()]?.cityId ? String(IATA[String(d.destination || '').toUpperCase()]!.cityId) : null, originIata: originIata || null,
          hotelName: '', hotelStars: 0, boardType: null,
          departureCity: IATA[originIata]?.city || originIata,
          departureDate: new Date(dep).toISOString(), nights,
          priceUAH: price, oldPriceUAH: null, operator: 'Aviasales',
          affiliateDeepLink: this.aviasalesLink(originIata, String(d.destination || '').toUpperCase(), dep, ret),
        });
      }
      return out;
    } catch (e: any) {
      this.logger.warn(`TP flight deals error: ${e?.message || e}`);
      return [];
    }
  }

  private aviasalesLink(origin: string, dest: string, depart: string, ret?: string): string {
    const dm = (d: string) => { const x = new Date(d); return String(x.getDate()).padStart(2, '0') + String(x.getMonth() + 1).padStart(2, '0'); };
    let path = `${origin}${dm(depart)}${dest}`;
    if (ret) path += dm(ret);
    return `https://www.aviasales.com/search/${path}1?marker=${encodeURIComponent(this.marker)}`;
  }

  // ── Mode A: custom package-tour feed from a TP program ──
  private async fromCustomFeed(): Promise<NormalizedTour[]> {
    try {
      const r = await fetch(this.feedUrl, { headers: { 'X-Access-Token': this.token } });
      if (!r.ok) { this.logger.warn(`TP tours feed HTTP ${r.status}`); return []; }
      const j: any = await r.json();
      const rows: any[] = Array.isArray(j) ? j : (j?.tours || j?.data || j?.result || []);
      return rows.map((t) => this.normalize(t)).filter(Boolean) as NormalizedTour[];
    } catch (e: any) {
      this.logger.warn(`TP tours feed error: ${e?.message || e}`);
      return [];
    }
  }

  private normalize(t: any): NormalizedTour | null {
    const country = String(t.country || t.destinationCountry || '').trim();
    const city = String(t.city || t.resort || t.destinationCity || '').trim();
    const price = Number(t.price || t.priceUAH || t.value || 0);
    const link = String(t.link || t.url || t.partner_url || t.affiliateDeepLink || '').trim();
    if (!country || !city || !price || !link) return null;
    return {
      destinationCountry: country, destinationCity: city,
      countryCode: t.countryCode || t.cc || countryCodeOf(country),
      destIata: t.destIata || t.iata || null, destCityId: t.cityId || t.locationId || null, originIata: t.originIata || t.fromIata || this.depIata(),
      hotelName: String(t.hotel || t.hotelName || '').trim() || `Отель в ${city}`,
      hotelStars: Number(t.stars || t.hotelStars || 0), boardType: t.board || t.boardType || null,
      departureCity: String(t.from || t.departureCity || '').trim() || this.departures[0] || 'Київ',
      departureDate: new Date(t.date || t.departureDate || Date.now()).toISOString(),
      nights: Number(t.nights || 7), priceUAH: Math.round(price),
      oldPriceUAH: t.oldPrice || t.oldPriceUAH ? Math.round(Number(t.oldPrice || t.oldPriceUAH)) : null,
      operator: t.operator || null, affiliateDeepLink: link,
    };
  }
}
