import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ITourProvider, NormalizedTour, TOUR_PROVIDERS } from './hottours.types';
import { SYSTEM_PROMPT, TEMPLATES, nextTemplate } from './templates';
import { countryCodeOf } from './geo-names';
import { TravelpayoutsProvider } from '../travel/providers/travelpayouts.provider';

const MONTHS_RU = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];

@Injectable()
export class HotToursService {
  private readonly logger = new Logger(HotToursService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(TOUR_PROVIDERS) private readonly providers: ITourProvider[],
    private readonly tp: TravelpayoutsProvider,
  ) {}

  private get enabledProviders() { return this.providers.filter((p) => p.enabled); }
  private get maxArticles() { return this.config.get<number>('HOT_TOURS_MAX_ARTICLES') ?? 7; }
  private get cronBatch() { return this.config.get<number>('HOT_TOURS_CRON_BATCH') ?? 4; }   // per daily cron
  private get tickBatch() { return this.config.get<number>('HOT_TOURS_TICK_BATCH') ?? 1; }   // per 30-min tick
  private get minDiscount() { return this.config.get<number>('HOT_TOURS_MIN_DISCOUNT') ?? 15; }
  private get minStars() { return this.config.get<number>('HOT_TOURS_MIN_STARS') ?? 4; }
  private get author() { return this.config.get<string>('HOT_TOURS_AUTHOR') || 'Олена Гринчук'; }
  private get baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || 'https://atm-travel.org').replace(/\/$/, ''); }
  private get blobToken() { return this.config.get<string>('BLOB_READ_WRITE_TOKEN') || ''; }
  private get pixabayKey() { return this.config.get<string>('PIXABAY_API_KEY') || ''; }
  private get pexelsKey() { return this.config.get<string>('PEXELS_API_KEY') || ''; }
  private get usdRate() { return Number(this.config.get('HOT_TOURS_USD_RATE')) || 41.5; }  // UAH per 1 USD fallback
  private get eurRate() { return Number(this.config.get('HOT_TOURS_EUR_RATE')) || 45.0; }  // UAH per 1 EUR fallback
  // UAH per 1 unit of each currency (base = UAH, as the feeds price in UAH).
  private fxCache: { rates: Record<string, number>; at: number } | null = null;
  private get fxRates(): Record<string, number> {
    return this.fxCache?.rates || { USD: this.usdRate, EUR: this.eurRate, UAH: 1 };
  }
  get fxUsdRate() { return this.fxRates.USD; }
  get fxTable(): Record<string, number> { return this.fxRates; }

  /** Refresh live NBU rates (UAH per USD/EUR; public, no key) and cache them in the DB. */
  async refreshFxRate(): Promise<Record<string, number>> {
    try {
      const r = await fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', {
        headers: { Accept: 'application/json' },
      });
      if (r.ok) {
        const rows: any[] = await r.json();
        const pick = (cc: string) => Number((Array.isArray(rows) ? rows.find((x) => x?.cc === cc) : null)?.rate);
        const rates: Record<string, number> = { UAH: 1 };
        const usd = pick('USD'), eur = pick('EUR');
        if (usd > 0) rates.USD = usd;
        if (eur > 0) rates.EUR = eur;
        if (rates.USD || rates.EUR) {
          this.fxCache = { rates: { USD: rates.USD || this.usdRate, EUR: rates.EUR || this.eurRate, UAH: 1 }, at: Date.now() };
          await this.prisma.sitemapCache.upsert({
            where: { key: 'fx-uah' }, create: { key: 'fx-uah', xml: JSON.stringify(this.fxCache.rates) }, update: { xml: JSON.stringify(this.fxCache.rates) },
          }).catch(() => {});
          return this.fxCache.rates;
        }
      } else this.logger.warn(`NBU rate HTTP ${r.status}`);
    } catch (e: any) { this.logger.warn(`NBU rate error: ${e?.message || e}`); }
    await this.ensureFxRate();
    return this.fxRates;
  }

  /** Load cached rates from the DB if this (cold) instance hasn't got them yet. Cheap, for request paths. */
  async ensureFxRate(): Promise<Record<string, number>> {
    if (this.fxCache) return this.fxCache.rates;
    const row = await this.prisma.sitemapCache.findUnique({ where: { key: 'fx-uah' } }).catch(() => null);
    try {
      const parsed = row?.xml ? JSON.parse(row.xml) : null;
      if (parsed && Number(parsed.USD) > 0) this.fxCache = { rates: { USD: Number(parsed.USD), EUR: Number(parsed.EUR) || this.eurRate, UAH: 1 }, at: Date.now() };
    } catch { /* keep fallback */ }
    return this.fxRates;
  }

  // Display currency follows the article language; USD/EUR notes are added for universal reference.
  localeCurrency(locale: string): { code: string; label: string } {
    const m: Record<string, { code: string; label: string }> = {
      uk: { code: 'UAH', label: 'грн' }, ru: { code: 'UAH', label: 'грн' }, en: { code: 'USD', label: '$' },
      de: { code: 'EUR', label: '€' }, fr: { code: 'EUR', label: '€' }, it: { code: 'EUR', label: '€' },
      es: { code: 'EUR', label: '€' }, pt: { code: 'EUR', label: '€' },
    };
    return m[locale] || m.uk;
  }
  // Feed prices are UAH. Returns the localized main price + a USD/EUR note (the reference currencies
  // other than the main one), using the live NBU rates.
  priceBlock(locale: string, uah: number): { main: string; note: string | null; code: string; amount: number } {
    const rates = this.fxRates;
    const conv = (code: string) => code === 'UAH' ? Math.round(uah) : Math.round(uah / (rates[code] || (code === 'EUR' ? this.eurRate : this.usdRate)));
    const label = (code: string, v: number) =>
      code === 'UAH' ? `${v.toLocaleString('uk-UA')} грн` : code === 'USD' ? `$${v.toLocaleString('en-US')}` : `€${v.toLocaleString('en-US')}`;
    const cur = this.localeCurrency(locale);
    const amount = conv(cur.code);
    const refs = ['USD', 'EUR'].filter((c) => c !== cur.code).map((c) => '≈ ' + label(c, conv(c)));
    return { main: label(cur.code, amount), note: refs.length ? refs.join(' · ') : null, code: cur.code, amount };
  }

  /** Called at the end of the single daily cron. Returns a short summary for the run log. */
  async runCron(): Promise<{ providers: number; ingested: number; expired: number; generated: number }> {
    await this.refreshFxRate();   // live UAH/USD from NBU, cached for the price notes
    if (!this.enabledProviders.length) {
      this.logger.log('hot-tours: no feed configured (need TRAVELPAYOUTS_* + HOT_TOURS_TP_FEED_URL or HOT_TOURS_MISTO_FEED_URL) — skipped');
      await this.buildSitemaps();
      return { providers: 0, ingested: 0, expired: 0, generated: 0 };
    }
    const ingested = await this.ingest();
    const expired = await this.expireStale(ingested.seenHashes);
    const generated = await this.generateArticles(this.cronBatch);
    await this.buildSitemaps();
    return { providers: this.enabledProviders.length, ingested: ingested.count, expired, generated };
  }

  // ── Ingestion + dedupe (price change updates the row; article is NOT regenerated) ──
  private async ingest(): Promise<{ count: number; seenHashes: Set<string> }> {
    const seen = new Set<string>();
    let count = 0;
    for (const p of this.enabledProviders) {
      let tours: NormalizedTour[] = [];
      try { tours = await p.fetchTours(); } catch (e: any) { this.logger.warn(`${p.providerId} fetch failed: ${e?.message || e}`); }
      for (const t of tours) {
        const hash = this.dedupeHash(t, p.providerId);
        seen.add(hash);
        const discountPct = t.oldPriceUAH && t.oldPriceUAH > t.priceUAH
          ? Math.round((1 - t.priceUAH / t.oldPriceUAH) * 100) : 0;
        const data = {
          destinationCountry: t.destinationCountry, destinationCity: t.destinationCity,
          countryCode: t.countryCode || countryCodeOf(t.destinationCountry),
          destIata: t.destIata || null, destCityId: t.destCityId || null, originIata: t.originIata || null,
          hotelName: t.hotelName, hotelStars: t.hotelStars, boardType: t.boardType || null,
          departureCity: t.departureCity, departureDate: new Date(t.departureDate), nights: t.nights,
          priceUAH: t.priceUAH, oldPriceUAH: t.oldPriceUAH || null, discountPct,
          operator: t.operator || null, affiliateDeepLink: t.affiliateDeepLink,
          providerId: p.providerId, active: true, fetchedAt: new Date(),
        };
        try {
          // Detect a price drop vs the currently stored price (dedupeHash excludes price, so this is the same offer).
          let priceExtra: any = {};
          const existing = await this.prisma.hotTour.findUnique({ where: { dedupeHash: hash }, select: { priceUAH: true } }).catch(() => null);
          if (existing && t.priceUAH < existing.priceUAH) priceExtra = { priceDropAt: new Date(), prevPriceUAH: existing.priceUAH };
          // upsert by dedupeHash: existing tour just gets fresh price/availability, keeps its article.
          await this.prisma.hotTour.upsert({ where: { dedupeHash: hash }, create: { ...data, dedupeHash: hash }, update: { ...data, ...priceExtra } });
          count++;
        } catch (e: any) { this.logger.warn(`upsert failed: ${e?.message || e}`); }
      }
    }
    return { count, seenHashes: seen };
  }

  // Hash excludes price → same tour at a new price maps to the same row (no duplicate page).
  private dedupeHash(t: NormalizedTour, providerId: string): string {
    const key = [t.hotelName, t.destinationCity, t.departureCity, t.departureDate.slice(0, 10), t.operator || '', providerId]
      .join('|').toLowerCase();
    return createHash('sha1').update(key).digest('hex');
  }

  // ── Expiry: departureDate passed OR gone from the latest feed → active=false (kept in DB). ──
  private async expireStale(seenHashes: Set<string>): Promise<number> {
    const now = new Date();
    const active = await this.prisma.hotTour.findMany({ where: { active: true }, select: { id: true, dedupeHash: true, departureDate: true } });
    const stale = active.filter((t) => t.departureDate < now || !seenHashes.has(t.dedupeHash)).map((t) => t.id);
    if (!stale.length) return 0;
    await this.prisma.hotTour.updateMany({ where: { id: { in: stale } }, data: { active: false } });
    // archive their published articles so they leave the news sitemap but stay in the DB
    await this.prisma.hotTourArticle.updateMany({ where: { tourId: { in: stale }, status: 'published' }, data: { status: 'archived' } });
    return stale.length;
  }

  // ── Generate up to N articles (default 7) for interesting tours that have none yet ──
  private async generateArticles(limit = this.cronBatch): Promise<number> {
    const key = this.config.get<string>('XAI_API_KEY');
    if (!key) { this.logger.warn('hot-tours: XAI_API_KEY not set — generation skipped'); return 0; }
    const candidates = await this.prisma.hotTour.findMany({
      where: {
        active: true, article: { is: null },
        OR: [
          { providerId: 'travelpayouts' }, // cheapest-48h flight deals are inherently "hot"
          { AND: [{ hotelStars: { gte: this.minStars } }, { discountPct: { gte: this.minDiscount } }] },
        ],
      },
      orderBy: [{ discountPct: 'desc' }, { fetchedAt: 'desc' }], take: limit * 3,
    });
    let made = 0;
    for (const tour of candidates) {
      if (made >= limit) break;
      try { if (await this.generateOne(tour, key)) made++; }
      catch (e: any) { this.logger.warn(`generate failed for ${tour.destinationCity}: ${e?.message || e}`); }
    }
    return made;
  }

  /** Small batch on demand (hourly pg_cron tick). With ingest=true also refreshes the feed + expiry. */
  async generateTick(withIngest = false): Promise<{ generated: number; ingested?: number; expired?: number }> {
    await this.ensureFxRate();
    if (withIngest && this.enabledProviders.length) {
      const ing = await this.ingest();
      const expired = await this.expireStale(ing.seenHashes);
      const generated = await this.generateArticles(this.tickBatch);
      await this.buildSitemaps();   // expiry may archive published articles → keep sitemaps fresh
      return { generated, ingested: ing.count, expired };
    }
    return { generated: await this.generateArticles(this.tickBatch) };
  }

  // Generate one article with the similarity-guard (ТЗ В.2): shingle+MinHash Jaccard and H1 fuzzy
  // vs recent same-country articles; on a near-duplicate, regenerate with another template (≤2),
  // else store as 'needs_manual' (blocked from publish, flagged for a human).
  private async generateOne(tour: any, key: string): Promise<boolean> {
    let lastTpl: string | null = (await this.prisma.hotTourArticle.findFirst({
      where: { tour: { destinationCountry: tour.destinationCountry } }, orderBy: { createdAt: 'desc' }, select: { templateId: true },
    }))?.templateId || null;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const tpl = nextTemplate(lastTpl); lastTpl = tpl.id;
      const gen = await this.callGrok(tour, tpl.brief, key);
      if (!gen || !gen.h1 || !Array.isArray(gen.sections)) continue;
      const sig = this.minhash(this.bodyText(gen));
      const dup = await this.isDuplicate(tour.destinationCountry, sig, String(gen.h1));
      if (dup && attempt < maxRetries) { this.logger.log(`hot-tours: near-duplicate for ${tour.destinationCity} → regenerating`); continue; }
      const slug = await this.uniqueSlug(tour);
      const contentHash = createHash('sha1').update(JSON.stringify(gen.sections)).digest('hex');
      const place = `${tour.destinationCity}, ${tour.destinationCountry}`.trim();
      const imgs = await this.pickImages(gen.image_queries || [], gen.image_alt_texts || [], slug, place, 4);
      const img = imgs[0] || null;
      await this.prisma.hotTourArticle.create({
        data: {
          tourId: tour.id, slug, locale: 'ru', templateId: gen.template_id || tpl.id,
          h1: String(gen.h1).slice(0, 300), metaDescription: String(gen.meta_description || '').slice(0, 320),
          bodyJson: gen, contentHash, minhashSig: JSON.stringify(sig),
          status: dup ? 'needs_manual' : 'draft', authorName: this.author,
          imageUrl: img?.url || null, imageAlt: img?.alt || null, imageSource: img?.source || null, imageSourceUrl: img?.sourceUrl || null, imagesJson: imgs as any,
        },
      });
      return true;
    }
    return false;
  }

  // ── Similarity-guard primitives (no external deps; embedding tie-break is a future add) ──
  private bodyText(gen: any): string {
    return (gen?.sections || []).map((s: any) => `${s.heading || ''} ${s.body || ''}`).join(' ');
  }
  private shingles(text: string, k = 5): string[] {
    const w = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i + k <= w.length; i++) out.push(w.slice(i, i + k).join(' '));
    return out.length ? out : w;
  }
  private hashStr(s: string, seed: number): number {
    let h = (seed ^ 0x9e3779b9) >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }
  private minhash(text: string, perms = 128): number[] {
    const sig = new Array(perms).fill(0xffffffff);
    for (const sh of new Set(this.shingles(text))) {
      for (let p = 0; p < perms; p++) { const hv = this.hashStr(sh, p + 1); if (hv < sig[p]) sig[p] = hv; }
    }
    return sig;
  }
  private jaccardEst(a: number[], b: number[]): number {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let eq = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
    return eq / a.length;
  }
  private h1Similarity(a: string, b: string): number {
    const sa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const sb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (!sa.size || !sb.size) return 0;
    let inter = 0; for (const w of sa) if (sb.has(w)) inter++;
    return inter / (sa.size + sb.size - inter);
  }
  private async isDuplicate(country: string, sig: number[], h1: string): Promise<boolean> {
    const since = new Date(Date.now() - 90 * 864e5);
    const recent = await this.prisma.hotTourArticle.findMany({
      where: { createdAt: { gte: since }, tour: { destinationCountry: country }, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' }, take: 50, select: { minhashSig: true, h1: true },
    });
    for (const r of recent) {
      if (r.h1 && this.h1Similarity(h1, r.h1) >= 0.85) return true;      // h1_fuzzy_block
      if (r.minhashSig) { try { if (this.jaccardEst(sig, JSON.parse(r.minhashSig)) >= 0.40) return true; } catch {} }  // jaccard_block
    }
    return false;
  }

  private async callGrok(tour: any, templateBrief: string, key: string): Promise<any | null> {
    const isFlight = !tour.hotelName;
    const hotelLines = isFlight ? '' : `hotelName: ${tour.hotelName}\nhotelStars: ${tour.hotelStars}\nboardType: ${tour.boardType || '-'}\n`;
    const facts =
      `dealType: ${isFlight ? 'горящий авиабилет (перелёт, БЕЗ отеля — не выдумывай отель/питание)' : 'пакетный тур (перелёт + отель)'}\n` +
      `destinationCountry: ${tour.destinationCountry}\ndestinationCity: ${tour.destinationCity}\n` + hotelLines +
      `departureCity: ${tour.departureCity}\ndepartureDate: ${new Date(tour.departureDate).toISOString().slice(0, 10)}\n` +
      `nights: ${tour.nights}\npriceUAH: ${tour.priceUAH}\noldPriceUAH: ${tour.oldPriceUAH || '-'}\n` +
      `discountPct: ${tour.discountPct}\noperator: ${tour.operator || '-'}\nlocale: ru\nauthor_persona: ${this.author}`;
    const user = `TOUR_FACTS:\n${facts}\n\nTEMPLATE:\n${templateBrief}`;
    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
    });
    if (!resp.ok) { this.logger.warn(`xAI ${resp.status}`); return null; }
    const data: any = await resp.json();
    return this.parseJson(data?.choices?.[0]?.message?.content || '');
  }

  private parseJson(s: string): any {
    if (!s) return null;
    let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
    return null;
  }

  // ── Image picker (ТЗ §6): Pixabay primary, Pexels fallback → download → our Vercel Blob. ──
  // Landscape/safe-search bias; the Grok image_queries are scenery ("coastline/beach/aerial").
  // Fetch >=min distinct photos (Grok's queries + destination-derived fallbacks) so the article isn't a single-photo page.
  private async pickImages(queries: string[], alts: string[], slug: string, place: string, min = 4): Promise<Array<{ url: string; alt: string; source: string; sourceUrl: string }>> {
    if (!this.blobToken) return [];
    const t = (place || '').trim();
    const base = (queries || []).map((s) => String(s || '').trim()).filter(Boolean);
    const extra = [`${t} beach`, `${t} hotel`, `${t} cityscape`, `${t} landmark`, `${t} street`, `${t} travel`];
    const qlist = [...new Set([...base, ...extra])].filter(Boolean).slice(0, 8);
    const alt0 = (alts || []).find(Boolean) || t || 'travel';
    const out: Array<{ url: string; alt: string; source: string; sourceUrl: string }> = [];
    const seen = new Set<string>();
    const { put } = await import('@vercel/blob');
    for (let i = 0; i < qlist.length && out.length < Math.max(min, 3); i++) {
      const found = (await this.searchPixabay(qlist[i])) || (await this.searchPexels(qlist[i]));
      if (!found || seen.has(found.downloadUrl)) continue;
      seen.add(found.downloadUrl);
      try {
        const img = await fetch(found.downloadUrl); if (!img.ok) continue;
        const buf = Buffer.from(await img.arrayBuffer());
        const ct = img.headers.get('content-type') || 'image/jpeg';
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const blob = await put(`hot-tours/${slug}-${out.length}.${ext}`, buf, { access: 'public', token: this.blobToken, contentType: ct, addRandomSuffix: true });
        out.push({ url: blob.url, alt: (alts || [])[out.length] || alt0, source: found.source, sourceUrl: found.sourceUrl });
      } catch (e: any) { this.logger.warn(`image ${i} upload failed: ${e?.message || e}`); }
    }
    return out;
  }

  // Fetch ONE new photo not already used on the article — for the editor's "Заменить" (replace) button.
  private async fetchFreshImage(place: string, slug: string, avoid: Set<string>, imgIdx: number, origQueries?: string[]): Promise<{ url: string; alt: string; source: string; sourceUrl: string } | null> {
    if (!this.blobToken) return null;
    const t = (place || '').trim() || 'travel';
    const qlist = [...new Set([...(origQueries || []), `${t} beach`, `${t} hotel`, `${t} cityscape`, `${t} landmark`, `${t} street`, `${t} travel`])].filter(Boolean);
    for (const q of qlist) {
      const found = (await this.searchPixabay(q)) || (await this.searchPexels(q));
      if (!found || avoid.has(found.downloadUrl)) continue;
      try {
        const img = await fetch(found.downloadUrl); if (!img.ok) continue;
        const buf = Buffer.from(await img.arrayBuffer());
        const ct = img.headers.get('content-type') || 'image/jpeg';
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const { put } = await import('@vercel/blob');
        const blob = await put(`hot-tours/${slug}-r${imgIdx}-${Date.now()}.${ext}`, buf, { access: 'public', token: this.blobToken, contentType: ct, addRandomSuffix: true });
        return { url: blob.url, alt: t, source: found.source, sourceUrl: found.sourceUrl };
      } catch (e: any) { this.logger.warn(`replace image failed: ${e?.message || e}`); }
    }
    return null;
  }

  private async searchPixabay(q: string): Promise<{ source: string; downloadUrl: string; sourceUrl: string } | null> {
    if (!this.pixabayKey) return null;
    try {
      const url = `https://pixabay.com/api/?key=${this.pixabayKey}&q=${encodeURIComponent(q)}` +
        `&image_type=photo&orientation=horizontal&safesearch=true&per_page=6`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const j: any = await r.json();
      const h = (j.hits || [])[0];
      if (!h) return null;
      return { source: 'pixabay', downloadUrl: h.largeImageURL || h.webformatURL, sourceUrl: h.pageURL };
    } catch { return null; }
  }

  private async searchPexels(q: string): Promise<{ source: string; downloadUrl: string; sourceUrl: string } | null> {
    if (!this.pexelsKey) return null;
    try {
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=6&orientation=landscape`,
        { headers: { Authorization: this.pexelsKey } });
      if (!r.ok) return null;
      const j: any = await r.json();
      const p = (j.photos || [])[0];
      if (!p) return null;
      return { source: 'pexels', downloadUrl: p.src?.large || p.src?.medium, sourceUrl: p.url };
    } catch { return null; }
  }

  private async uniqueSlug(tour: any): Promise<string> {
    const base = this.slugify(`${tour.destinationCity}-${tour.hotelStars}star-${new Date(tour.departureDate).toISOString().slice(0, 10)}`);
    let slug = base, n = 1;
    while (await this.prisma.hotTourArticle.findUnique({ where: { slug } })) slug = `${base}-${++n}`;
    return slug;
  }
  private slugify(s: string): string {
    const map: Record<string, string> = { а:'a',б:'b',в:'v',г:'g',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'iu',я:'ia' };
    return s.toLowerCase().split('').map((c) => map[c] ?? c).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'tour';
  }

  // ── Accordion data: published articles of ACTIVE tours, grouped by country ──
  async accordion(): Promise<any[]> {
    const rows = await this.prisma.hotTourArticle.findMany({
      where: { status: 'published', tour: { active: true } },
      include: { tour: true }, orderBy: { publishedAt: 'desc' },
    });
    const byCountry = new Map<string, any>();
    for (const a of rows) {
      const t = a.tour;
      const g = byCountry.get(t.destinationCountry) || {
        country: t.destinationCountry, cc: (t.countryCode || countryCodeOf(t.destinationCountry) || '').toLowerCase(),
        priceMin: Infinity, priceMax: 0, dateMin: null as Date | null, dateMax: null as Date | null, articles: [] as any[],
      };
      g.priceMin = Math.min(g.priceMin, t.priceUAH); g.priceMax = Math.max(g.priceMax, t.priceUAH);
      if (!g.dateMin || t.departureDate < g.dateMin) g.dateMin = t.departureDate;
      if (!g.dateMax || t.departureDate > g.dateMax) g.dateMax = t.departureDate;
      g.articles.push({ slug: a.slug, h1: a.h1, city: t.destinationCity, hotel: t.hotelName, stars: t.hotelStars,
        priceUAH: t.priceUAH, oldPriceUAH: t.oldPriceUAH, discountPct: t.discountPct, departureDate: t.departureDate, nights: t.nights,
        image: a.imageUrl || null, imageAlt: a.imageAlt || null });
      byCountry.set(t.destinationCountry, g);
    }
    return [...byCountry.values()].map((g) => ({
      country: g.country, cc: g.cc,
      priceMin: isFinite(g.priceMin) ? g.priceMin : null, priceMax: g.priceMax || null,
      dateMin: g.dateMin, dateMax: g.dateMax, count: g.articles.length, articles: g.articles,
    })).sort((a, b) => b.count - a.count);
  }

  // ── Single article (published) for the SEO page ──
  async articleBySlug(slug: string) {
    const a = await this.prisma.hotTourArticle.findUnique({ where: { slug }, include: { tour: true } });
    if (!a || a.status !== 'published') return null;
    return a;
  }

  // For admin preview: return the article regardless of status.
  async articleAnyStatus(slug: string) {
    return this.prisma.hotTourArticle.findUnique({ where: { slug }, include: { tour: true } });
  }

  // ── Human-gate admin ──
  adminAllowed(key?: string): boolean {
    const t = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN') || '';
    return !!t && key === t;
  }

  // Cron/pg_cron auth (same CRON_SECRET as the daily refresh).
  cronAllowed(auth?: string, xsec?: string): boolean {
    const s = this.config.get<string>('CRON_SECRET');
    return !!s && (auth === `Bearer ${s}` || xsec === s);
  }

  /** Log an outbound tour-link click (channel + campaign + sub) and return the affiliate URL + UTM. */
  async trackTourClick(tourId: string, channel: string, campaign?: string, sub?: string): Promise<string> {
    const ch = ['email', 'telegram', 'whatsapp', 'site'].includes(channel) ? channel : 'site';
    const camp = (campaign || 'saved-search').slice(0, 40);
    const t = await this.prisma.hotTour.findUnique({ where: { id: tourId }, select: { affiliateDeepLink: true } }).catch(() => null);
    await this.prisma.tourClick.create({ data: { tourId, channel: ch, campaign: camp, sub: sub || null } }).catch(() => {});
    const raw = t?.affiliateDeepLink || `${this.baseUrl}/hot-tours`;
    // Ensure Travelpayouts attribution: tag SubID on marker links, wrap unmarked TP-brand links; plain otherwise.
    const url = await this.tp.affiliateLink(raw, `${camp}_${sub || ch}`);
    if (/\.tp\.st\//i.test(url)) return url;                       // shortened affiliate link — don't append params
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}utm_source=atm-travel&utm_medium=${encodeURIComponent(ch)}&utm_campaign=${encodeURIComponent(camp)}`;
  }

  /** Drafts + needs_manual awaiting review, each with a lazily-computed competitiveness rating. */
  async drafts(): Promise<any[]> {
    const rows = await this.prisma.hotTourArticle.findMany({
      where: { status: { in: ['draft', 'needs_manual'] } }, include: { tour: true }, orderBy: { createdAt: 'desc' }, take: 100,
    });
    const out: any[] = [];
    for (const a of rows) {
      const rating = await this.ratingFor(a);
      const t = a.tour;
      const bj: any = a.bodyJson || {};
      out.push({
        id: a.id, slug: a.slug, h1: a.h1, status: a.status, image: a.imageUrl, imageAlt: a.imageAlt,
        city: t.destinationCity, country: t.destinationCountry, cc: (t.countryCode || '').toLowerCase(),
        hotel: t.hotelName, stars: t.hotelStars, priceUAH: t.priceUAH, oldPriceUAH: t.oldPriceUAH,
        discountPct: t.discountPct, departureDate: t.departureDate, nights: t.nights,
        ratingPct: rating.pct, ratingNote: rating.note, uncertain: bj.uncertain_facts || [],
      });
    }
    return out;
  }

  // ── Inline editor (admin), mirrors the blog editor: load parts, regenerate a part, persist edits ──
  async articleForEdit(id: string): Promise<any | null> {
    const a = await this.prisma.hotTourArticle.findUnique({ where: { id }, include: { tour: true } }).catch(() => null);
    if (!a) return null;
    const bj: any = a.bodyJson || {};
    const sections = (bj.sections || []).map((s: any) => ({
      heading: s.heading || '',
      paragraphs: String(s.body || '').split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean),
    }));
    const images = Array.isArray(a.imagesJson) && a.imagesJson.length
      ? a.imagesJson
      : (a.imageUrl ? [{ url: a.imageUrl, alt: a.imageAlt, source: a.imageSource, sourceUrl: a.imageSourceUrl }] : []);
    const t: any = a.tour;
    return { id: a.id, h1: a.h1, locale: a.locale, status: a.status, image: a.imageUrl, images, embedImages: a.embedImages !== false, place: t ? `${t.destinationCity}, ${t.destinationCountry}` : '', sections, uncertainFacts: bj.uncertain_facts || [] };
  }

  async applyEdit(id: string, patch: { h1?: string; sections?: { heading: string; paragraphs: string[] }[]; images?: { url: string; alt?: string; source?: string; sourceUrl?: string }[]; embedImages?: boolean }): Promise<boolean> {
    const a = await this.prisma.hotTourArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return false;
    const bj: any = a.bodyJson || {};
    const sections = Array.isArray(patch.sections)
      ? patch.sections.map((s) => ({ heading: String(s.heading || '').slice(0, 300), body: (s.paragraphs || []).map((p) => String(p || '').trim()).filter(Boolean).join('\n\n') })).filter((s) => s.body || s.heading)
      : bj.sections;
    const newBj = { ...bj, sections };
    const images = Array.isArray(patch.images) ? patch.images.filter((i) => i?.url) : undefined;
    const hero = images ? images[0] : undefined;
    await this.prisma.hotTourArticle.update({
      where: { id },
      data: {
        h1: patch.h1 != null && String(patch.h1).trim() ? String(patch.h1).slice(0, 300) : a.h1,
        bodyJson: newBj as any,
        ratingPct: null, ratingNote: null,   // edits invalidate the competitiveness rating so it's recomputed
        ...(typeof patch.embedImages === 'boolean' ? { embedImages: patch.embedImages } : {}),
        ...(images ? {
          imagesJson: images as any,
          imageUrl: hero?.url || null, imageAlt: hero?.alt || null, imageSource: hero?.source || null, imageSourceUrl: hero?.sourceUrl || null,
        } : {}),
      },
    });
    return true;
  }

  private async grokRaw(sys: string, user: string): Promise<string | null> {
    const key = this.config.get<string>('XAI_API_KEY');
    if (!key) return null;
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      return String(data?.choices?.[0]?.message?.content || '').trim();
    } catch { return null; }
  }

  async regeneratePart(id: string, part: string, sectionIdx?: number, paraIdx?: number, current?: string, note?: string, mode?: string, imgIdx?: number): Promise<{ ok: boolean; value?: any; message?: string }> {
    const a = await this.prisma.hotTourArticle.findUnique({ where: { id }, include: { tour: true } }).catch(() => null);
    if (!a) return { ok: false, message: 'not found' };
    const t: any = a.tour;
    if (part === 'image') {
      if (!this.blobToken) return { ok: false, message: 'нет BLOB_READ_WRITE_TOKEN' };
      const bj0: any = a.bodyJson || {};
      const existing: any[] = Array.isArray(a.imagesJson) && a.imagesJson.length ? a.imagesJson : (a.imageUrl ? [{ url: a.imageUrl }] : []);
      const avoid = new Set(existing.map((x) => x?.url).filter(Boolean));
      const place = t ? `${t.destinationCity}, ${t.destinationCountry}` : '';
      const fresh = await this.fetchFreshImage(place, a.slug, avoid, imgIdx ?? existing.length, bj0.image_queries);
      if (!fresh) return { ok: false, message: 'не нашли новое фото (стоки исчерпаны или нет ключей)' };
      return { ok: true, value: fresh };
    }
    if (!this.config.get<string>('XAI_API_KEY')) return { ok: false, message: 'нет XAI_API_KEY' };
    const bj: any = a.bodyJson || {};
    const ctx = `Направление: ${t?.destinationCity || ''}, ${t?.destinationCountry || ''}. Отель: ${t?.hotelName || '—'} ${t?.hotelStars || ''}★. Цена: ${t?.priceUAH || ''} грн${t?.discountPct ? ` (−${t.discountPct}%)` : ''}.`;
    const extra = [
      note && note.trim() ? `Учитывай пожелание редактора: ${note.trim().slice(0, 300)}.` : '',
      mode === 'shorter' ? 'Сделай ЗАМЕТНО КОРОЧЕ — оставь только суть, убери лишнее.' : '',
      mode === 'longer' ? 'Сделай ПОДРОБНЕЕ — добавь конкретику и полезные детали, без воды и повторов.' : '',
    ].filter(Boolean).join(' ');
    const strip = (s: string) => s.replace(/^["'«»\s]+|["'«»\s]+$/g, '');
    if (part === 'title') {
      const sys = `Ты — редактор travel-статей о горящих турах. Перепиши ЗАГОЛОВОК: сделай его более привлекательным и цепляющим, но честным — НЕ меняй город/страну/отель/цену. ${extra} Язык: русский. Верни ТОЛЬКО текст заголовка, без кавычек.`;
      const out = await this.grokRaw(sys, `${ctx}\nТекущий заголовок: ${(current && current.trim()) || a.h1}`);
      if (!out) return { ok: false, message: 'grok failed' };
      return { ok: true, value: strip(out).slice(0, 300) };
    }
    if (part === 'paragraph') {
      const sec = (bj.sections || [])[sectionIdx ?? -1]; if (!sec) return { ok: false, message: 'no section' };
      const paras = String(sec.body || '').split(/\n{2,}/);
      const cur = (current && current.trim()) || paras[paraIdx ?? -1]; if (cur == null) return { ok: false, message: 'no paragraph' };
      const sys = `Ты — редактор travel-статей о горящих турах. Переформулируй абзац: КОНКРЕТНЕЕ, меньше воды, чётче смысл; сохрани факты (цену/даты/отель не выдумывай и не меняй). ${extra} Верни ТОЛЬКО переписанный абзац.`;
      const out = await this.grokRaw(sys, `${ctx}\nРаздел: ${sec.heading}\nАбзац: ${cur}`);
      if (!out) return { ok: false, message: 'grok failed' };
      return { ok: true, value: strip(out).trim() };
    }
    return { ok: false, message: 'unknown part' };
  }


  async publish(id: string): Promise<boolean> {
    const a = await this.prisma.hotTourArticle.findUnique({ where: { id } });
    if (!a) return false;
    await this.prisma.hotTourArticle.update({ where: { id }, data: { status: 'published', publishedAt: a.publishedAt || new Date() } });
    await this.buildSitemaps();
    return true;
  }

  /** Increment the page-view counter (cheap total) and log a view event (for the daily chart). */
  // Counter only (lifetime total). Sub-tagged view events come from the client ping (trackView).
  async bumpView(id: string, slug?: string): Promise<void> {
    await this.prisma.hotTourArticle.update({ where: { id }, data: { views: { increment: 1 } } }).catch(() => {});
  }
  // Client view ping — a sub-tagged view event for the daily chart + cohort funnel.
  async trackView(slug: string, sub?: string): Promise<void> {
    await this.prisma.hotTourView.create({ data: { slug: slug || '', sub: sub || null } }).catch(() => {});
  }
  async trackEmailOpen(campaign: string): Promise<void> {
    await this.prisma.emailEvent.create({ data: { campaign: (campaign || '').slice(0, 60) || 'unknown', kind: 'open' } }).catch(() => {});
  }
  async logEmailSend(campaign: string): Promise<void> {
    await this.prisma.emailEvent.create({ data: { campaign: (campaign || '').slice(0, 60) || 'unknown', kind: 'send' } }).catch(() => {});
  }

  private weekStartUTC(d: Date | number): Date {
    const x = new Date(d); const day = (x.getUTCDay() + 6) % 7;
    x.setUTCDate(x.getUTCDate() - day); x.setUTCHours(0, 0, 0, 0); return x;
  }

  /** Take a weekly snapshot of each subscriber's state (active/paused/canceled). Idempotent per week. */
  async snapshotSubscribers(): Promise<{ subs: number }> {
    const rows = await this.prisma.savedSearch.findMany({ select: { id: true, sub: true, active: true, canceledAt: true } }).catch(() => [] as any[]);
    const bySub = new Map<string, { active: boolean; open: boolean }>();
    for (const r of rows) {
      const key = r.sub || r.id;
      const cur = bySub.get(key) || { active: false, open: false };
      if (r.active) cur.active = true;
      if (!r.canceledAt) cur.open = true;   // exists and not canceled (active or paused)
      bySub.set(key, cur);
    }
    const week = this.weekStartUTC(new Date());
    let n = 0;
    for (const [sub, v] of bySub) {
      const state = v.active ? 'active' : (v.open ? 'paused' : 'canceled');
      await this.prisma.subscriberWeek.upsert({ where: { sub_week: { sub, week } }, create: { sub, week, state }, update: { state } }).catch(() => {});
      n++;
    }
    return { subs: n };
  }

  // ── Subscriber retention: week-by-week survival triangle. Uses weekly snapshots where available
  //    (so pauses count as not-retained for that week), and falls back to canceledAt history otherwise. ──
  async retention(maxWeeks = 12): Promise<any> {
    const rows = await this.prisma.savedSearch.findMany({ select: { id: true, sub: true, createdAt: true, active: true, canceledAt: true } }).catch(() => [] as any[]);
    const bySub = new Map<string, { first: Date; anyOpen: boolean; lastCancel: Date | null; anyActive: boolean }>();
    for (const r of rows) {
      const key = r.sub || r.id;
      const cur = bySub.get(key) || { first: r.createdAt, anyOpen: false, lastCancel: null, anyActive: false };
      if (r.createdAt < cur.first) cur.first = r.createdAt;
      if (!r.canceledAt) cur.anyOpen = true;
      else if (!cur.lastCancel || r.canceledAt > cur.lastCancel) cur.lastCancel = r.canceledAt;
      if (r.active) cur.anyActive = true;
      bySub.set(key, cur);
    }
    const WEEK = 6.048e8, now = Date.now();
    const people = [...bySub.entries()].map(([sub, v]) => ({ sub, first: v.first, churnedAt: v.anyOpen ? null : v.lastCancel, active: v.anyActive }));

    // Load snapshots into a map: `${sub}|${weekISO}` → state.
    const snaps = await this.prisma.subscriberWeek.findMany({ select: { sub: true, week: true, state: true } }).catch(() => [] as any[]);
    const snap = new Map<string, string>();
    for (const s of snaps) snap.set(`${s.sub}|${new Date(s.week).toISOString().slice(0, 10)}`, s.state);

    const cohortsMap = new Map<string, { sub: string; first: Date; churnedAt: Date | null }[]>();
    for (const p of people) {
      const key = this.weekStartUTC(p.first).toISOString().slice(0, 10);
      (cohortsMap.get(key) || cohortsMap.set(key, []).get(key)!).push({ sub: p.sub, first: p.first, churnedAt: p.churnedAt });
    }
    const cohorts = [...cohortsMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, maxWeeks)
      .map(([week, members]) => {
        const wsMs = new Date(week).getTime();
        const ageWeeks = Math.floor((this.weekStartUTC(now).getTime() - wsMs) / WEEK);
        const size = members.length;
        const cells: (number | null)[] = [];
        for (let w = 0; w <= maxWeeks; w++) {
          if (w > ageWeeks) { cells.push(null); continue; }
          const targetIso = this.weekStartUTC(wsMs + w * WEEK).toISOString().slice(0, 10);
          const boundary = wsMs + w * WEEK;
          const retained = members.filter((m) => {
            const st = snap.get(`${m.sub}|${targetIso}`);
            if (st) return st === 'active';                          // real historical state (pause counts as not retained)
            return !m.churnedAt || m.churnedAt.getTime() >= boundary; // fallback: not canceled by that week
          }).length;
          cells.push(size ? Math.round((retained / size) * 1000) / 10 : 0);
        }
        return { week, size, ageWeeks, cells };
      });

    const totalSubs = people.length;
    const totalActive = people.filter((p) => p.active).length;
    return {
      totalSubs, totalActive,
      activeRate: totalSubs ? Math.round((totalActive / totalSubs) * 1000) / 10 : 0,
      maxOffset: Math.min(maxWeeks, Math.max(0, ...cohorts.map((c) => c.ageWeeks), 0)),
      cohorts,
    };
  }

  // ── Weekly effectiveness digest to the site owner (email + Telegram) ──
  async adminDigest(): Promise<{ ok: boolean; sent: string[] }> {
    const s: any = await this.stats(7);
    const activeSubs = await this.prisma.savedSearch.count({ where: { active: true } }).catch(() => 0);
    const f = s.funnel, co = s.cohort;
    const ab = (s.emailAb || []).slice(0, 6).map((c: any) => `  ${c.campaign}: отпр ${c.sends}, откр ${c.opens} (${c.openRate}%), клик ${c.clicks} (${c.clickRate}%)`).join('\n') || '  —';
    const tops = (s.topDirections || []).slice(0, 5).map((d: any) => `  ${d.country}: CTR ${d.ctr}% (${d.views}/${d.clicks})`).join('\n') || '  —';
    const text =
`📊 ATM-travel — эффективность (сводка)

Показы статей: ${f.views} · клики /go: ${f.articleClicks} (${f.cvrViewToClick}%) · переходы по турам: ${f.tourClicks} (${f.cvrClickToTour}%)
Клики за 7 дней: ${s.clicks7} · переходов за 7 дней: ${s.tourClicks?.last7 ?? 0}
Активных подписок: ${activeSubs}

Когорта по пользователю (sub): показ ${co.viewed} → клик ${co.clicked} (${co.cvrViewClick}%) → переход ${co.transitioned} (${co.cvrClickTrans}%)

A/B писем (тема → отправки/открытия/клики):
${ab}

Топ направлений по CTR:
${tops}

Открыть дашборд: ${this.baseUrl}/hot-admin`;
    const sent: string[] = [];
    const tgChat = this.config.get<string>('ADMIN_TELEGRAM_CHAT_ID');
    if (tgChat && await this.tgSend(tgChat, text)) sent.push('telegram');
    const email = this.config.get<string>('ADMIN_EMAIL');
    if (email && await this.mailSend(email, 'ATM-travel — сводка эффективности', text)) sent.push('email');
    return { ok: true, sent };
  }

  private async tgSend(chatId: string, text: string): Promise<boolean> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN'); if (!token) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    }).catch(() => null);
    return !!r && r.ok;
  }
  private async mailSend(to: string, subject: string, text: string): Promise<boolean> {
    const key = this.config.get<string>('RESEND_API_KEY'); const from = this.config.get<string>('MAIL_FROM');
    if (!key || !from) return false;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    }).catch(() => null);
    return !!r && r.ok;
  }

  /** Visits + clicks stats for the admin dashboard (+ daily series and top directions by CTR). */
  async stats(days = 30): Promise<any> {
    const clickRows: any[] = await this.prisma.hotTourClick.groupBy({ by: ['slug'], _count: { _all: true } }).catch(() => []);
    const clickMap = new Map<string, number>((clickRows as any[]).map((r) => [r.slug, r._count._all] as [string, number]));
    const since7 = new Date(Date.now() - 7 * 864e5);
    const clicks7 = await this.prisma.hotTourClick.count({ where: { ts: { gte: since7 } } }).catch(() => 0);
    const arts = await this.prisma.hotTourArticle.findMany({
      where: { status: { in: ['published', 'archived'] } }, include: { tour: true }, orderBy: { views: 'desc' }, take: 200,
    });
    let totalViews = 0, totalClicks = 0;
    const rows = arts.map((a) => {
      const clicks = Number(clickMap.get(a.slug) || 0);
      totalViews += a.views; totalClicks += clicks;
      return {
        slug: a.slug, h1: a.h1, city: a.tour.destinationCity, country: a.tour.destinationCountry,
        cc: (a.tour.countryCode || '').toLowerCase(), status: a.status, views: a.views, clicks,
        ctr: a.views ? Math.round((clicks / a.views) * 1000) / 10 : 0,
      };
    }).sort((x, y) => (y.views + y.clicks) - (x.views + x.clicks));

    // daily series (last N days): views + clicks per day, zero-filled
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setTime(since.getTime() - (days - 1) * 864e5);
    const [viewEv, clickEv] = await Promise.all([
      this.prisma.hotTourView.findMany({ where: { ts: { gte: since } }, select: { ts: true } }).catch(() => []),
      this.prisma.hotTourClick.findMany({ where: { ts: { gte: since } }, select: { ts: true } }).catch(() => []),
    ]);
    const dk = (d: any) => new Date(d).toISOString().slice(0, 10);
    const bucket = new Map<string, { date: string; views: number; clicks: number }>();
    for (let i = 0; i < days; i++) { const k = dk(new Date(since.getTime() + i * 864e5)); bucket.set(k, { date: k, views: 0, clicks: 0 }); }
    for (const e of viewEv as any[]) { const b = bucket.get(dk(e.ts)); if (b) b.views++; }
    for (const e of clickEv as any[]) { const b = bucket.get(dk(e.ts)); if (b) b.clicks++; }
    const daily = [...bucket.values()];

    // top directions by CTR (aggregate article rows by country)
    const byCc = new Map<string, { cc: string; country: string; views: number; clicks: number }>();
    for (const r of rows) {
      if (!r.cc) continue;
      const g = byCc.get(r.cc) || { cc: r.cc, country: r.country, views: 0, clicks: 0 };
      g.views += r.views; g.clicks += r.clicks; byCc.set(r.cc, g);
    }
    const topDirections = [...byCc.values()]
      .map((g) => ({ ...g, ctr: g.views ? Math.round((g.clicks / g.views) * 1000) / 10 : 0 }))
      .filter((g) => g.views > 0).sort((a, b) => b.ctr - a.ctr || b.views - a.views).slice(0, 10);

    // Outbound tour-link clicks (subscriptions/search/site) by channel.
    const tcTotal = await this.prisma.tourClick.count().catch(() => 0);
    const tc7 = await this.prisma.tourClick.count({ where: { ts: { gte: since7 } } }).catch(() => 0);
    const tcByCh: any[] = await this.prisma.tourClick.groupBy({ by: ['channel'], _count: { _all: true } }).catch(() => []);
    const tcByCamp: any[] = await this.prisma.tourClick.groupBy({ by: ['channel', 'campaign'], _count: { _all: true } }).catch(() => []);
    const tourClicks = {
      total: tcTotal, last7: tc7,
      byChannel: tcByCh.map((r) => ({ channel: r.channel, count: r._count._all })).sort((a, b) => b.count - a.count),
      byCampaign: tcByCamp.map((r) => ({ channel: r.channel, campaign: r.campaign || '—', count: r._count._all })).sort((a, b) => b.count - a.count).slice(0, 30),
    };

    // Unified conversion funnel: article views → article CTA clicks (/go/hot-tour) → tour link clicks (/go/tour).
    const funnel = {
      views: totalViews,
      articleClicks: totalClicks,
      tourClicks: tcTotal,
      cvrViewToClick: totalViews ? Math.round((totalClicks / totalViews) * 1000) / 10 : 0,
      cvrClickToTour: totalClicks ? Math.round((tcTotal / totalClicks) * 1000) / 10 : 0,
    };

    // Email A/B: sends/opens (EmailEvent) + email clicks (TourClick) per campaign (campaign encodes the variant).
    const ee: any[] = await this.prisma.emailEvent.groupBy({ by: ['campaign', 'kind'], _count: { _all: true } }).catch(() => []);
    const emap = new Map<string, { sends: number; opens: number }>();
    for (const r of ee) { const m = emap.get(r.campaign) || { sends: 0, opens: 0 }; if (r.kind === 'send') m.sends = r._count._all; else if (r.kind === 'open') m.opens = r._count._all; emap.set(r.campaign, m); }
    const clickByCamp = new Map<string, number>();
    tcByCamp.filter((r) => r.channel === 'email').forEach((r) => clickByCamp.set(r.campaign || '—', (clickByCamp.get(r.campaign || '—') || 0) + r._count._all));
    const emailAb = [...emap.entries()].map(([campaign, m]) => ({
      campaign, sends: m.sends, opens: m.opens,
      openRate: m.sends ? Math.round((m.opens / m.sends) * 1000) / 10 : 0,
      clicks: clickByCamp.get(campaign) || 0,
      clickRate: m.sends ? Math.round(((clickByCamp.get(campaign) || 0) / m.sends) * 1000) / 10 : 0,
    })).sort((a, b) => b.sends - a.sends).slice(0, 30);

    // Cohort funnel stitched by subscriber id: viewed → (of them) clicked article → (of them) transitioned.
    const [gv, gc, gt]: any[] = await Promise.all([
      this.prisma.hotTourView.groupBy({ by: ['sub'], where: { sub: { not: null } } }).catch(() => []),
      this.prisma.hotTourClick.groupBy({ by: ['sub'], where: { sub: { not: null } } }).catch(() => []),
      this.prisma.tourClick.groupBy({ by: ['sub'], where: { sub: { not: null } } }).catch(() => []),
    ]);
    const vs = new Set(gv.map((r: any) => r.sub)), cs = new Set(gc.map((r: any) => r.sub)), ts2 = new Set(gt.map((r: any) => r.sub));
    const viewed = vs.size;
    const clicked = [...vs].filter((x) => cs.has(x)).length;
    const transitioned = [...vs].filter((x) => cs.has(x) && ts2.has(x)).length;
    const cohort = {
      viewed, clicked, transitioned,
      cvrViewClick: viewed ? Math.round((clicked / viewed) * 1000) / 10 : 0,
      cvrClickTrans: clicked ? Math.round((transitioned / clicked) * 1000) / 10 : 0,
      anyClickers: cs.size, anyTransitioners: ts2.size,
    };

    return {
      totalViews, totalClicks, clicks7,
      ctr: totalViews ? Math.round((totalClicks / totalViews) * 1000) / 10 : 0,
      daily, topDirections, tourClicks, funnel, emailAb, cohort, rows,
    };
  }

  /** Grok competitiveness/relevance rating vs other platforms (heuristic). Cached on the article. */
  async ratingFor(a: any): Promise<{ pct: number | null; note: string }> {
    if (a.ratingPct != null) return { pct: a.ratingPct, note: a.ratingNote || '' };
    const key = this.config.get<string>('XAI_API_KEY');
    if (!key) return { pct: null, note: '' };
    const t = a.tour || (await this.prisma.hotTour.findUnique({ where: { id: a.tourId } }));
    if (!t) return { pct: null, note: '' };
    const facts = `Направление: ${t.destinationCity}, ${t.destinationCountry}. Отель: ${t.hotelName || '—'} ${t.hotelStars}★. ` +
      `Цена: ${t.priceUAH} грн${t.oldPriceUAH ? ` (была ${t.oldPriceUAH}, −${t.discountPct}%)` : ''}. Ночей: ${t.nights}. ` +
      `Вылет: ${new Date(t.departureDate).toISOString().slice(0, 10)} из ${t.departureCity}.`;
    const sys = 'Ты — travel-аналитик. Оцени, насколько ЭТО предложение конкурентно и актуально относительно типичных цен ' +
      'на других площадках (эвристически, без доступа к их данным — по цене, скидке, звёздности, сезону, дате вылета). ' +
      'Верни СТРОГО JSON без markdown: {"percent": <целое 0-100>, "text": "<1-2 предложения по-русски: чем выгодно/невыгодно и стоит ли брать>"}.';
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: sys }, { role: 'user', content: facts }] }),
      });
      if (!resp.ok) return { pct: null, note: '' };
      const data: any = await resp.json();
      const j = this.parseJson(data?.choices?.[0]?.message?.content || '');
      const pct = Math.max(0, Math.min(100, Math.round(Number(j?.percent))));
      const note = String(j?.text || '').slice(0, 500);
      if (Number.isFinite(pct)) {
        await this.prisma.hotTourArticle.update({ where: { id: a.id }, data: { ratingPct: pct, ratingNote: note } }).catch(() => {});
        return { pct, note };
      }
    } catch (e: any) { this.logger.warn(`rating failed: ${e?.message || e}`); }
    return { pct: null, note: '' };
  }

  // ── Click tracking: log the click, return the affiliate deep link to 302 to (or null). ──
  async trackClick(slug: string, referrer?: string, ua?: string, sub?: string): Promise<string | null> {
    const a = await this.prisma.hotTourArticle.findUnique({ where: { slug }, include: { tour: true } });
    const url = a?.tour?.affiliateDeepLink;
    if (!url) return null;
    // Await the write so it isn't dropped when the serverless function returns after the redirect.
    try {
      await this.prisma.hotTourClick.create({
        data: { slug, articleId: a.id, sub: sub || null, referrer: (referrer || '').slice(0, 500) || null, ua: (ua || '').slice(0, 500) || null },
      });
    } catch (e: any) { this.logger.warn(`click log failed: ${e?.message || e}`); }
    return this.tp.affiliateLink(url, `article_${sub || 'web'}`);
  }

  monthRu(d: Date) { return MONTHS_RU[new Date(d).getMonth()]; }

  // Active tours/hotels/flights for a destination (by country code) — used by the reel builder.
  async toursForDestination(cc: string): Promise<any[]> {
    const where: any = { active: true };
    if (cc) where.countryCode = cc.toUpperCase();
    const rows = await this.prisma.hotTour.findMany({ where, orderBy: [{ discountPct: 'desc' }, { fetchedAt: 'desc' }], take: 40 });
    return rows.map((t) => ({
      id: t.id, city: t.destinationCity, country: t.destinationCountry, cc: (t.countryCode || '').toLowerCase(),
      destIata: t.destIata, destCityId: t.destCityId, originIata: t.originIata,
      hotel: t.hotelName, stars: t.hotelStars, boardType: t.boardType,
      departureCity: t.departureCity, departureDate: t.departureDate, nights: t.nights,
      priceUAH: t.priceUAH, oldPriceUAH: t.oldPriceUAH, discountPct: t.discountPct,
      operator: t.operator, providerId: t.providerId, link: t.affiliateDeepLink,
    }));
  }

  // ── Sitemaps: rendered here (cached in DB — Vercel FS is ephemeral) ──
  robotsTxt(): string {
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /hot-admin',
      'Disallow: /reels-admin',
      'Disallow: /very-good-ffmpeg',
      'Disallow: /very-good-ffmpeg',
      'Disallow: /api/',
      `Sitemap: ${this.baseUrl}/sitemap.xml`,
      `Sitemap: ${this.baseUrl}/sitemap-news.xml`,
      `Sitemap: ${this.baseUrl}/sitemap-blog.xml`,
      '',
    ].join('\n');
  }

  async buildSitemaps(): Promise<void> {
    const pub = await this.prisma.hotTourArticle.findMany({
      where: { status: 'published', tour: { active: true } },
      include: { tour: true }, orderBy: { publishedAt: 'desc' },
    });
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : new Date().toISOString());

    const blogPub = await this.prisma.blogArticle.findMany({
      where: { status: 'published' }, select: { slug: true, updatedAt: true }, orderBy: { publishedAt: 'desc' }, take: 5000,
    }).catch(() => [] as any[]);

    const urls = [
      `<url><loc>${this.baseUrl}/</loc></url>`,
      `<url><loc>${this.baseUrl}/hot-tours</loc></url>`,
      `<url><loc>${this.baseUrl}/blog</loc></url>`,
      ...pub.map((a) => `<url><loc>${this.baseUrl}/hot-tours/${a.slug}</loc><lastmod>${iso(a.updatedAt)}</lastmod></url>`),
      ...blogPub.map((a: any) => `<url><loc>${this.baseUrl}/blog/${a.slug}</loc><lastmod>${iso(a.updatedAt)}</lastmod></url>`),
    ];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;

    // news sitemap: only fresh (<=2 days) published articles of ACTIVE tours (expired ones drop out)
    const twoDays = Date.now() - 2 * 864e5;
    const news = pub.filter((a) => a.publishedAt && new Date(a.publishedAt).getTime() >= twoDays).map((a) =>
      `<url><loc>${this.baseUrl}/hot-tours/${a.slug}</loc>` +
      `<news:news><news:publication><news:name>ATM-travel</news:name><news:language>${a.locale}</news:language></news:publication>` +
      `<news:publication_date>${iso(a.publishedAt)}</news:publication_date><news:title>${esc(a.h1)}</news:title></news:news></url>`);
    const sitemapNews = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${news.join('\n')}\n</urlset>`;

    for (const [k, xml] of [['sitemap', sitemap], ['sitemap-news', sitemapNews]] as const) {
      try { await this.prisma.sitemapCache.upsert({ where: { key: k }, create: { key: k, xml }, update: { xml } }); }
      catch (e: any) { this.logger.warn(`sitemap cache ${k} failed: ${e?.message || e}`); }
    }
  }

  async sitemapXml(key: 'sitemap' | 'sitemap-news'): Promise<string> {
    const row = await this.prisma.sitemapCache.findUnique({ where: { key } }).catch(() => null);
    if (row?.xml) return row.xml;
    await this.buildSitemaps();
    const again = await this.prisma.sitemapCache.findUnique({ where: { key } }).catch(() => null);
    return again?.xml || '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
  }
}
