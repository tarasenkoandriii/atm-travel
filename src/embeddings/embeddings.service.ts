import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createHash } from 'crypto';

interface EmbeddingProvider { modelId: string; dimensions: number; normalized: boolean; embed(texts: string[]): Promise<number[][]>; }

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private get dim() { return Number(this.config.get<number>('EMBEDDINGS_DIM') ?? 1024); }
  private get batch() { return Number(this.config.get<number>('EMBED_BATCH_SIZE') ?? 96); }
  private get maxPerRun() { return Number(this.config.get<number>('MAX_EMBEDS_PER_RUN') ?? 300); }

  // ── Provider (DI-style): OpenAI-compatible when a key is set, else a deterministic mock. ──
  private provider(): EmbeddingProvider {
    const url = this.config.get<string>('EMBEDDINGS_API_URL') || 'https://api.openai.com/v1/embeddings';
    const key = this.config.get<string>('EMBEDDINGS_API_KEY') || '';
    const model = this.config.get<string>('EMBEDDINGS_MODEL') || 'text-embedding-3-small';
    const dim = this.dim;
    if (!key) {
      return {
        modelId: 'mock-' + dim, dimensions: dim, normalized: true,
        embed: async (texts) => texts.map((t) => this.mockVector(t, dim)),
      };
    }
    return {
      modelId: model, dimensions: dim, normalized: true,
      embed: async (texts) => {
        const r = await fetch(url, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
        });
        if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
        const j: any = await r.json();
        const out = (j?.data || []).sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding as number[]);
        if (out.length !== texts.length) throw new Error('embeddings count mismatch');
        return out;
      },
    };
  }

  private mockVector(text: string, dim: number): number[] {
    const v = new Array(dim);
    let h = createHash('sha256').update(text).digest();
    for (let i = 0; i < dim; i++) { if (i % 32 === 0) h = createHash('sha256').update(h).digest(); v[i] = (h[i % 32] / 255) * 2 - 1; }
    let n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }

  // ── Deterministic embedding text + embed_hash (two-hash strategy §2/§5.1) ──
  private seasonBucket(d?: Date | null): string {
    if (!d) return 'сезон-любой';
    const m = new Date(d).getUTCMonth();
    return m <= 1 || m === 11 ? 'зима' : m <= 4 ? 'весна' : m <= 7 ? 'лето' : 'осень';
  }
  private priceBucket(uah?: number | null): string {
    const p = Number(uah || 0);
    return p < 20000 ? 'economy' : p < 45000 ? 'standard' : 'premium';
  }
  buildEmbeddingText(t: any): string {
    return [
      `Направление: ${t.destinationCity}${t.countryCode ? `, ${t.countryCode}` : ''}`,
      `Страна: ${t.destinationCountry || ''}`,
      t.hotelName ? `Отель: ${t.hotelName}` : '',
      t.boardType ? `Питание: ${t.boardType}` : '',
      t.nights ? `Длительность: ${t.nights} ноч.` : '',
      `Сезон: ${this.seasonBucket(t.departureDate)}`,
      `Ценовой сегмент: ${this.priceBucket(t.priceUAH)}`,
      t.hotelName ? 'Пакетный тур' : 'Перелёт',
    ].filter(Boolean).join('. ');
  }
  private embedHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

  /** Re-embed only tours whose semantic text changed (or that are new), new-first, capped per run.
   *  Guarded by a Postgres advisory lock so overlapping cron runs don't double-work (§4.1). */
  async embedChanged(limit = this.maxPerRun): Promise<{ candidates: number; embedded: number; failed: number; skipped?: boolean }> {
    // advisory lock (best-effort; if it can't be taken, another run is in progress)
    let locked = false;
    try {
      const got: any[] = await this.prisma.$queryRawUnsafe(`select pg_try_advisory_lock(hashtext('orbita_embed')) as got`);
      locked = !!got?.[0]?.got;
      if (!locked) { await this.prisma.syncRun.create({ data: { status: 'skipped', finishedAt: new Date() } }).catch(() => {}); return { candidates: 0, embedded: 0, failed: 0, skipped: true }; }
    } catch { /* advisory lock unavailable → proceed without it */ }

    const run = await this.prisma.syncRun.create({ data: { status: 'running' } }).catch(() => null);
    let embedded = 0, failed = 0, candidates = 0;
    try {
      const tours = await this.prisma.hotTour.findMany({
        where: { active: true },
        select: { id: true, destinationCity: true, destinationCountry: true, countryCode: true, hotelName: true, boardType: true, nights: true, departureDate: true, priceUAH: true },
        orderBy: { fetchedAt: 'desc' }, take: 2000,
      });
      const existing: any[] = await this.prisma.$queryRawUnsafe('select tour_id, embed_hash from tour_embeddings').catch(() => []);
      const have = new Map(existing.map((r) => [r.tour_id, r.embed_hash]));
      const pending = tours.map((t) => ({ t, text: this.buildEmbeddingText(t), isNew: !have.has(t.id) }))
        .map((x) => ({ ...x, hash: this.embedHash(x.text) }))
        .filter((x) => x.isNew || have.get(x.t.id) !== x.hash)
        .sort((a, b) => (a.isNew === b.isNew ? 0 : a.isNew ? -1 : 1))
        .slice(0, limit);
      candidates = pending.length;
      const prov = this.provider();
      for (let i = 0; i < pending.length; i += this.batch) {
        const chunk = pending.slice(i, i + this.batch);
        try {
          const vectors = await this.withRetry(() => prov.embed(chunk.map((c) => c.text)), 3);
          if (vectors.length !== chunk.length) throw new Error('batch length mismatch');
          for (let j = 0; j < chunk.length; j++) {
            const vec = vectors[j];
            if (!Array.isArray(vec) || vec.length !== this.dim) { failed++; this.logger.warn(`dim mismatch for ${chunk[j].t.id}`); continue; }
            const lit = `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
            await this.prisma.$executeRawUnsafe(
              `insert into tour_embeddings (tour_id, embedding, embed_hash, model_id, embedded_at)
               values ($1, $2::vector, $3, $4, now())
               on conflict (tour_id) do update set embedding = excluded.embedding, embed_hash = excluded.embed_hash, model_id = excluded.model_id, embedded_at = now()`,
              chunk[j].t.id, lit, chunk[j].hash, prov.modelId,
            );
            embedded++;
          }
        } catch (e: any) { failed += chunk.length; this.logger.warn(`embed batch failed: ${e?.message || e}`); }
      }
      const status = failed ? 'partial' : 'ok';
      if (run) await this.prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status, candidates, embedded, embedFailed: failed } }).catch(() => {});
      if (failed) await this.alert(`эмбеддинги: прогон ${status}, candidates=${candidates}, embedded=${embedded}, failed=${failed}`);
    } catch (e: any) {
      if (run) await this.prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: 'failed', error: String(e?.message || e).slice(0, 400) } }).catch(() => {});
      await this.alert(`эмбеддинги: прогон FAILED — ${String(e?.message || e).slice(0, 200)}`);
    } finally {
      if (locked) await this.prisma.$executeRawUnsafe(`select pg_advisory_unlock(hashtext('orbita_embed'))`).catch(() => {});
    }
    return { candidates, embedded, failed };
  }

  private async alert(text: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN'); const chat = this.config.get<string>('ADMIN_TELEGRAM_CHAT_ID');
    if (!token || !chat) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `⚠️ ОРБИТА · ${text}` }) }).catch(() => {});
  }

  /** Watchdog (§8): alert if no healthy embed run finished in the last `maxMin` minutes. Deduped so it fires once per window. */
  async watchdog(maxMin = 90): Promise<{ stale: boolean }> {
    const last = await this.prisma.syncRun.findFirst({ where: { status: { in: ['ok', 'partial'] }, finishedAt: { not: null } }, orderBy: { startedAt: 'desc' } }).catch(() => null);
    const ageMin = last?.finishedAt ? (Date.now() - new Date(last.finishedAt).getTime()) / 60000 : Infinity;
    if (ageMin <= maxMin) return { stale: false };
    const lastWatch = await this.prisma.syncRun.findFirst({ where: { status: 'watchdog' }, orderBy: { startedAt: 'desc' } }).catch(() => null);
    if (lastWatch && (Date.now() - new Date(lastWatch.startedAt).getTime()) / 60000 < maxMin) return { stale: true }; // already alerted this window
    await this.alert(`нет свежего прогона эмбеддингов ${Number.isFinite(ageMin) ? `уже ~${Math.round(ageMin)} мин` : 'вообще'} (watchdog). Проверьте pg_cron /api/embed/run.`);
    await this.prisma.syncRun.create({ data: { status: 'watchdog', finishedAt: new Date() } }).catch(() => {});
    return { stale: true };
  }

  private async withRetry<T>(fn: () => Promise<T>, tries: number): Promise<T> {
    let last: any;
    for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * (i + 1) + Math.random() * 200)); } }
    throw last;
  }

  /** Hybrid RRF search via the SQL function; falls back to [] if pgvector isn't set up. */
  async searchTours(query: string, filters: { maxPriceUAH?: number | null; minStars?: number | null } = {}, k = 5): Promise<any[]> {
    try {
      const [vec] = await this.provider().embed([query || 'тур']);
      if (!vec || vec.length !== this.dim) return [];
      const lit = `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
      const rows: any[] = await this.prisma.$queryRawUnsafe(
        `select tour_id from search_tours($1::vector, $2, $3, $4, $5)`,
        lit, query || '', filters.maxPriceUAH ?? null, filters.minStars ?? null, k,
      );
      const ids = rows.map((r) => r.tour_id);
      if (!ids.length) return [];
      const tours = await this.prisma.hotTour.findMany({ where: { id: { in: ids } } });
      const order = new Map(ids.map((id, i) => [id, i]));
      return tours.sort((a, b) => (order.get(a.id)! - order.get(b.id)!)).map((t) => ({
        id: t.id, city: t.destinationCity, country: t.destinationCountry, cc: (t.countryCode || '').toLowerCase(),
        hotel: t.hotelName, stars: t.hotelStars, priceUAH: t.priceUAH, oldPriceUAH: t.oldPriceUAH, discountPct: t.discountPct,
        departureDate: t.departureDate, nights: t.nights, link: `/go/tour/${t.id}?u=site&c=chat`,
      }));
    } catch (e: any) { this.logger.warn(`hybrid search unavailable: ${e?.message || e}`); return []; }
  }
}
