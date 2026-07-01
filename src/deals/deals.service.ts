import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gunzipSync } from 'zlib';
import { PrismaService } from '../prisma/prisma.service';
import { TravelpayoutsProvider } from '../travel/providers/travelpayouts.provider';
import { Deal } from './deals.types';

const CACHE_KEY = 'deals:viator:top';

/**
 * "Горящие туры" showcase (ТЗ §8, extension). Ingests the Viator Deals feed from Travelpayouts
 * (a gzipped JSON list of discounted tours), keeps the biggest discounts, converts each tour link
 * into an affiliate link via the Partner Links API, and caches the result in DB (survives cold starts).
 *
 * The feed download URL is partner-specific and provided by Travelpayouts support — set it as
 * VIATOR_DEALS_FEED_URL. Without it, the showcase is simply empty (no fabricated discounts).
 */
@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);
  private mem: Deal[] = [];
  private memAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tp: TravelpayoutsProvider,
  ) {}

  get feedUrl() { return this.config.get<string>('VIATOR_DEALS_FEED_URL') || ''; }
  get minDiscount() { return this.config.get<number>('DEALS_MIN_DISCOUNT') ?? 10; }
  get limit() { return this.config.get<number>('DEALS_LIMIT') ?? 12; }
  get enabled() { return !!this.feedUrl; }

  /** Fetch + parse the feed, keep top discounts, affiliate-wrap links, cache. Returns count. */
  async refresh(): Promise<number> {
    if (!this.feedUrl) { this.logger.warn('VIATOR_DEALS_FEED_URL not set — deals showcase disabled'); return 0; }
    let list: any[] = [];
    try {
      const res = await fetch(this.feedUrl);
      if (!res.ok) { this.logger.warn(`Deals feed HTTP ${res.status}`); return this.mem.length; }
      const buf = Buffer.from(await res.arrayBuffer());
      let text: string;
      try { text = gunzipSync(buf).toString('utf8'); } // feed is gzipped
      catch { text = buf.toString('utf8'); }           // tolerate already-decompressed
      const json = JSON.parse(text);
      list = Array.isArray(json) ? json : (json.tours || json.deals || json.data || []);
    } catch (e) {
      this.logger.warn(`Deals feed error: ${String(e)}`);
      return this.mem.length;
    }

    const deals = list.map((x) => this.parse(x)).filter((d): d is Deal => !!d && d.discount >= this.minDiscount);
    deals.sort((a, b) => b.discount - a.discount);
    const top = deals.slice(0, this.limit);

    // Feed links are NOT affiliate links — convert them (batch, cached, graceful fallback).
    try {
      const aff = await this.tp.toAffiliate(top.map((d) => d.url), 'deals');
      top.forEach((d, i) => { if (aff[i]) d.url = aff[i]; });
    } catch (e) {
      this.logger.warn(`Deals affiliate conversion failed: ${String(e)}`);
    }

    this.mem = top; this.memAt = Date.now();
    try {
      await this.prisma.travelOfferCache.upsert({
        where: { key: CACHE_KEY },
        create: { key: CACHE_KEY, payload: top as any, fetchedAt: new Date() },
        update: { payload: top as any, fetchedAt: new Date() },
      });
    } catch { /* best-effort */ }
    this.logger.log(`Deals refreshed: ${top.length} discounted tours`);
    return top.length;
  }

  async list(limit?: number): Promise<Deal[]> {
    const n = limit || this.limit;
    if (this.mem.length && Date.now() - this.memAt < 6 * 3600_000) return this.mem.slice(0, n);
    try {
      const row = await this.prisma.travelOfferCache.findUnique({ where: { key: CACHE_KEY } });
      const arr = (row?.payload as any) as Deal[] | undefined;
      if (Array.isArray(arr)) { this.mem = arr; this.memAt = Date.now(); return arr.slice(0, n); }
    } catch { /* ignore */ }
    return [];
  }

  // Map one raw feed entry to a Deal. Field names beyond the documented ones are probed defensively.
  private parse(x: any): Deal | null {
    if (!x) return null;
    const name: string = x.product_name || x.title || '';
    const url: string = x.url || x.link || x.deep_link || x.merchant_deep_link || x.product_url || x.merchant_url || '';
    if (!url) return null;
    // discount: prefer explicit field, else parse "Save 15.00%!" from the product name
    let discount = Number(x.discount ?? x.discount_size ?? x.discount_percent ?? 0);
    if (!discount) {
      const m = name.match(/save\s+([\d.]+)\s*%/i);
      if (m) discount = Math.round(parseFloat(m[1]));
    }
    discount = Math.round(discount);
    const title = name.replace(/^\s*save\s+[\d.]+\s*%!?\s*/i, '').trim() || name;
    return {
      id: String(x.merchant_product_id || x.product_id || x.id || url),
      title,
      image: x.merchant_image_url || x.image || x.photo || '',
      url,
      discount,
      price: x.price != null ? Number(x.price) : (x.sale_price != null ? Number(x.sale_price) : null),
      oldPrice: x.old_price != null ? Number(x.old_price) : (x.original_price != null ? Number(x.original_price) : null),
      currency: x.currency || null,
      description: x.description || null,
    };
  }
}
