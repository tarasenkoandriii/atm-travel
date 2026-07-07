import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_PROMPT, TOPICS, nextTheme, themeLabel, geoForTopic, BlogTheme } from './blog-templates';

@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private get key() { return this.config.get<string>('XAI_API_KEY') || ''; }
  private get pixabayKey() { return this.config.get<string>('PIXABAY_API_KEY') || ''; }
  private get pexelsKey() { return this.config.get<string>('PEXELS_API_KEY') || ''; }
  private get blobToken() { return this.config.get<string>('BLOB_READ_WRITE_TOKEN') || ''; }
  private get author() { return this.config.get<string>('BLOG_AUTHOR') || this.config.get<string>('HOT_TOURS_AUTHOR') || 'Редакция ATM-travel'; }
  private get locales(): string[] { return (this.config.get<string>('BLOG_LOCALES') || 'uk,ru,en,de').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); }
  private get baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || 'https://atm-travel.org').replace(/\/$/, ''); }

  // ── Cron entry: generate one article per run (guides/tips/reviews/stories), across locales. ──
  async generateOne(): Promise<boolean> {
    if (!this.key) { this.logger.warn('blog: XAI_API_KEY not set — skip'); return false; }
    const { theme, topic, locale } = await this.pickAssignment();
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = await this.callGrok(theme, topic, locale);
      if (!gen?.h1 || !Array.isArray(gen.sections) || !gen.sections.length) return false;
      const body = this.bodyText(gen);
      const sig = this.minhash(body);
      const dup = await this.isDuplicate(sig, gen.h1);
      if (dup && attempt < 1) { this.logger.log(`blog: near-duplicate for ${topic} → retry`); continue; }
      const slug = await this.uniqueSlug(gen.h1);
      const imgs = await this.pickImages(gen.image_queries || [], gen.image_alt_texts || [], slug, topic, 4);
      const img = imgs[0] || null;
      await this.prisma.blogArticle.create({
        data: {
          slug, locale, theme: theme.id, topic,
          h1: String(gen.h1).slice(0, 300), metaDescription: String(gen.meta_description || '').slice(0, 300),
          bodyJson: { sections: gen.sections, uncertain_facts: gen.uncertain_facts || [], categories: Array.isArray(gen.categories) ? gen.categories.slice(0, 4) : [], tags: Array.isArray(gen.tags) ? gen.tags.slice(0, 6) : [], sources: Array.isArray(gen.sources) ? gen.sources.slice(0, 4) : [] } as any,
          contentHash: createHash('sha256').update(body).digest('hex'),
          minhashSig: JSON.stringify(sig),
          status: dup ? 'needs_manual' : 'draft', authorName: this.author,
          imageUrl: img?.url || null, imageAlt: img?.alt || null, imageSource: img?.source || null, imageSourceUrl: img?.sourceUrl || null, imagesJson: imgs as any,
        },
      });
      this.logger.log(`blog: generated «${gen.h1}» (${theme.id}/${topic}/${locale})${dup ? ' [needs_manual]' : ''}`);
      return true;
    }
    return false;
  }

  // Rotate theme + locale by the last article; pick the least-covered topic to spread coverage.
  private async pickAssignment(): Promise<{ theme: BlogTheme; topic: string; locale: string }> {
    const last = await this.prisma.blogArticle.findFirst({ orderBy: { createdAt: 'desc' }, select: { theme: true, locale: true } }).catch(() => null);
    const theme = nextTheme(last?.theme);
    const locs = this.locales;
    const li = last?.locale ? locs.indexOf(last.locale) : -1;
    const locale = locs[(li + 1) % locs.length] || 'ru';
    const pool = (this.config.get<string>('BLOG_TOPICS') || '').split('|').map((s) => s.trim()).filter(Boolean);
    const topics = pool.length ? pool : TOPICS;
    const grouped = await this.prisma.blogArticle.groupBy({ by: ['topic'], _count: { _all: true } }).catch(() => [] as any[]);
    const counts = new Map<string, number>((grouped as any[]).map((g: any) => [g.topic, g._count._all] as [string, number]));
    let best = topics[0]; let bestN = Infinity;
    for (const t of topics) { const n = counts.get(t) ?? 0; if (n < bestN) { bestN = n; best = t; } }
    return { theme, topic: best, locale };
  }

  private langName(locale: string): string {
    return ({ uk: 'украинском языке (українською мовою)', ru: 'русском языке', en: 'English', de: 'Deutsch (auf Deutsch)' } as Record<string, string>)[locale] || 'русском языке';
  }

  private async callGrok(theme: BlogTheme, topic: string, locale: string): Promise<any | null> {
    const user = `TOPIC: ${topic}\nAUTHOR_PERSONA: ${this.author}\n` +
      `ЯЗЫК СТАТЬИ: напиши ВСЮ статью (h1, заголовки секций, тело, meta_description, image_alt_texts) на ${this.langName(locale)}. image_queries оставь на английском.\n\n` +
      `THEME (строго следуй тону и структуре):\n${theme.brief}`;
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
      });
      if (!resp.ok) { this.logger.warn(`xAI ${resp.status}`); return null; }
      const data: any = await resp.json();
      return this.parseJson(data?.choices?.[0]?.message?.content || '');
    } catch (e: any) { this.logger.warn(`blog grok error: ${e?.message || e}`); return null; }
  }

  private parseJson(s: string): any {
    try { return JSON.parse(s); } catch {}
    const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }
  private bodyText(gen: any): string {
    return (gen.sections || []).map((x: any) => `${x.heading || ''}\n${x.body || ''}`).join('\n');
  }

  // ── Near-duplicate detection (MinHash over shingles) vs recent articles ──
  private shingles(text: string, k = 5): string[] {
    const w = (text.toLowerCase().match(/[a-zа-яёіїєґ0-9]+/gi) || []);
    const out: string[] = []; for (let i = 0; i + k <= w.length; i++) out.push(w.slice(i, i + k).join(' '));
    return out.length ? out : w;
  }
  private hashStr(s: string, seed: number): number {
    let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); } return h >>> 0;
  }
  private minhash(text: string, perms = 128): number[] {
    const sh = this.shingles(text); const sig = new Array(perms).fill(0xffffffff);
    for (const s of sh) for (let p = 0; p < perms; p++) { const hv = this.hashStr(s, p * 2654435761 + 1); if (hv < sig[p]) sig[p] = hv; }
    return sig;
  }
  private jaccardEst(a: number[], b: number[]): number {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let eq = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++; return eq / a.length;
  }
  private async isDuplicate(sig: number[], h1: string): Promise<boolean> {
    const recent = await this.prisma.blogArticle.findMany({ orderBy: { createdAt: 'desc' }, take: 60, select: { minhashSig: true, h1: true } }).catch(() => [] as any[]);
    for (const r of recent) {
      if (r.h1 && r.h1.toLowerCase() === h1.toLowerCase()) return true;
      if (!r.minhashSig) continue;
      try { if (this.jaccardEst(sig, JSON.parse(r.minhashSig)) >= 0.7) return true; } catch {}
    }
    return false;
  }

  // ── Image picker: Pixabay → Pexels → our Vercel Blob (same services as hot-tours). ──
  // Fetch >=min distinct photos (one per query) so the video slides differ. Grok queries + topic-derived fallbacks.
  private async pickImages(queries: string[], alts: string[], slug: string, topic: string, min = 3): Promise<Array<{ url: string; alt: string; source: string; sourceUrl: string }>> {
    if (!this.blobToken) return [];
    const t = topic.replace(/\(.*?\)/g, '').split(',')[0].trim();
    const base = (queries || []).map((s) => String(s || '').trim()).filter(Boolean);
    const extra = [`${t} cityscape`, `${t} landmark`, `${t} old town`, `${t} street`, `${t} nature`, `${t} travel`];
    const qlist = [...new Set([...base, ...extra])].slice(0, 8);
    const alt0 = (alts || []).find(Boolean) || t;
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
        const blob = await put(`blog/${slug}-${out.length}.${ext}`, buf, { access: 'public', token: this.blobToken, contentType: ct, addRandomSuffix: true });
        out.push({ url: blob.url, alt: (alts || [])[out.length] || alt0, source: found.source, sourceUrl: found.sourceUrl });
      } catch (e: any) { this.logger.warn(`blog image ${i} failed: ${e?.message || e}`); }
    }
    return out;
  }

  // Fetch ONE new photo not already used on the article — for the editor's "Заменить" (replace) button.
  private async fetchFreshImage(topic: string, slug: string, avoid: Set<string>, imgIdx: number, origQueries?: string[]): Promise<{ url: string; alt: string; source: string; sourceUrl: string } | null> {
    if (!this.blobToken) return null;
    const t = (topic || '').replace(/\(.*?\)/g, '').split(',')[0].trim() || 'travel';
    const qlist = [...new Set([...(origQueries || []), `${t} scenery`, `${t} landmark`, `${t} street`, `${t} cityscape`, `${t} nature`, `${t} travel`, `${t} old town`])].filter(Boolean);
    for (const q of qlist) {
      const found = (await this.searchPixabay(q)) || (await this.searchPexels(q));
      if (!found || avoid.has(found.downloadUrl)) continue;
      try {
        const img = await fetch(found.downloadUrl); if (!img.ok) continue;
        const buf = Buffer.from(await img.arrayBuffer());
        const ct = img.headers.get('content-type') || 'image/jpeg';
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const { put } = await import('@vercel/blob');
        const blob = await put(`blog/${slug}-r${imgIdx}-${Date.now()}.${ext}`, buf, { access: 'public', token: this.blobToken, contentType: ct, addRandomSuffix: true });
        return { url: blob.url, alt: t, source: found.source, sourceUrl: found.sourceUrl };
      } catch (e: any) { this.logger.warn(`replace image failed: ${e?.message || e}`); }
    }
    return null;
  }
  private async searchPixabay(q: string): Promise<{ source: string; downloadUrl: string; sourceUrl: string } | null> {
    if (!this.pixabayKey) return null;
    try {
      const r = await fetch(`https://pixabay.com/api/?key=${this.pixabayKey}&q=${encodeURIComponent(q)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=6`);
      if (!r.ok) return null; const j: any = await r.json(); const h = (j.hits || [])[0]; if (!h) return null;
      return { source: 'pixabay', downloadUrl: h.largeImageURL || h.webformatURL, sourceUrl: h.pageURL };
    } catch { return null; }
  }
  private async searchPexels(q: string): Promise<{ source: string; downloadUrl: string; sourceUrl: string } | null> {
    if (!this.pexelsKey) return null;
    try {
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=6&orientation=landscape`, { headers: { Authorization: this.pexelsKey } });
      if (!r.ok) return null; const j: any = await r.json(); const p = (j.photos || [])[0]; if (!p) return null;
      return { source: 'pexels', downloadUrl: p.src?.large || p.src?.medium, sourceUrl: p.url };
    } catch { return null; }
  }

  private slugify(s: string): string {
    const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ie', ё: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia' };
    return s.toLowerCase().split('').map((c) => (map[c] ?? c)).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'article';
  }
  private async uniqueSlug(h1: string): Promise<string> {
    const base = this.slugify(h1); let slug = base;
    for (let i = 2; await this.prisma.blogArticle.findUnique({ where: { slug } }).catch(() => null); i++) slug = `${base}-${i}`;
    return slug;
  }

  // ── Moderation: drafts with lazily-computed article + photo scores ──
  async drafts(): Promise<any[]> {
    const rows = await this.prisma.blogArticle.findMany({ where: { status: { in: ['draft', 'needs_manual'] } }, orderBy: { createdAt: 'desc' }, take: 100 });
    const out: any[] = [];
    for (const a of rows) {
      const art = await this.scoreArticle(a);
      const ph = await this.scorePhoto(a);
      out.push({
        id: a.id, slug: a.slug, h1: a.h1, theme: a.theme, topic: a.topic, status: a.status,
        image: a.imageUrl, imageAlt: a.imageAlt, imageSource: a.imageSource,
        metaDescription: a.metaDescription, uncertain: (a.bodyJson as any)?.uncertain_facts || [],
        articleScore: art.pct, articleNote: art.note, photoScore: ph.pct, photoNote: ph.note,
      });
    }
    return out;
  }

  // Text quality/originality/usefulness score (0-100) via Grok. Cached on the row.
  async scoreArticle(a: any): Promise<{ pct: number | null; note: string }> {
    if (a.articleScore != null) return { pct: a.articleScore, note: a.articleScoreNote || '' };
    if (!this.key) return { pct: null, note: '' };
    const body = (a.bodyJson as any)?.sections?.map((s: any) => `## ${s.heading}\n${s.body}`).join('\n\n') || '';
    const sys = 'Ты — строгий редактор travel-блога. Оцени статью по полезности, оригинальности, конкретике и отсутствию SEO-воды/клише. ' +
      'Верни СТРОГО JSON без markdown: {"percent": <целое 0-100>, "text": "<1-2 предложения по-русски: сильные/слабые стороны и стоит ли публиковать>"}.';
    const user = `Тема: ${a.theme}. Направление: ${a.topic}.\nЗаголовок: ${a.h1}\n\n${body.slice(0, 6000)}`;
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      if (!resp.ok) return { pct: null, note: '' };
      const data: any = await resp.json();
      const j = this.parseJson(data?.choices?.[0]?.message?.content || '');
      const pct = Math.max(0, Math.min(100, Math.round(Number(j?.percent))));
      const note = String(j?.text || '').slice(0, 500);
      if (Number.isFinite(pct)) { await this.prisma.blogArticle.update({ where: { id: a.id }, data: { articleScore: pct, articleScoreNote: note } }).catch(() => {}); return { pct, note }; }
    } catch (e: any) { this.logger.warn(`article score failed: ${e?.message || e}`); }
    return { pct: null, note: '' };
  }

  // Illustration score (0-100): Grok Vision on the hero image vs the topic; heuristic fallback.
  async scorePhoto(a: any): Promise<{ pct: number | null; note: string }> {
    if (a.photoScore != null) return { pct: a.photoScore, note: a.photoScoreNote || '' };
    if (!a.imageUrl) return { pct: 0, note: 'нет иллюстрации' };
    let pct: number | null = null; let note = '';
    if (this.key) {
      const sys = 'Ты — фоторедактор. Оцени, насколько это фото подходит как обложка статьи о направлении: релевантность теме, качество, отсутствие водяных знаков/людей крупным планом/текста. ' +
        'Верни СТРОГО JSON без markdown: {"percent": <0-100>, "text": "<кратко по-русски>"}.';
      try {
        const resp = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
          body: JSON.stringify({
            model: 'grok-4.3',
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: [{ type: 'text', text: `Тема статьи: ${a.topic}. Alt: ${a.imageAlt || '—'}.` }, { type: 'image_url', image_url: { url: a.imageUrl } }] },
            ],
          }),
        });
        if (resp.ok) { const data: any = await resp.json(); const j = this.parseJson(data?.choices?.[0]?.message?.content || ''); const p = Math.round(Number(j?.percent)); if (Number.isFinite(p)) { pct = Math.max(0, Math.min(100, p)); note = String(j?.text || '').slice(0, 400); } }
      } catch (e: any) { this.logger.warn(`photo score (vision) failed: ${e?.message || e}`); }
    }
    if (pct == null) { pct = a.imageSource ? 60 : 30; note = a.imageSource ? `эвристика: есть фото (${a.imageSource})` : 'эвристика: фото без источника'; } // fallback
    await this.prisma.blogArticle.update({ where: { id: a.id }, data: { photoScore: pct, photoScoreNote: note } }).catch(() => {});
    return { pct, note };
  }

  async publish(id: string): Promise<boolean> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } });
    if (!a) return false;
    await this.prisma.blogArticle.update({ where: { id }, data: { status: 'published', publishedAt: a.publishedAt || new Date() } });
    return true;
  }
  async reject(id: string): Promise<boolean> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return false;
    await this.prisma.blogArticle.update({ where: { id }, data: { status: 'archived' } });
    return true;
  }

  // ── Inline editor (admin): load parts, regenerate a part, persist edits ──
  async articleForEdit(id: string): Promise<any | null> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return null;
    const bj: any = a.bodyJson || {};
    const sections = (bj.sections || []).map((s: any) => ({
      heading: s.heading || '',
      paragraphs: String(s.body || '').split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean),
    }));
    const images = Array.isArray(a.imagesJson) && a.imagesJson.length
      ? a.imagesJson
      : (a.imageUrl ? [{ url: a.imageUrl, alt: a.imageAlt, source: a.imageSource, sourceUrl: a.imageSourceUrl }] : []);
    return { id: a.id, h1: a.h1, locale: a.locale, status: a.status, image: a.imageUrl, images, embedImages: a.embedImages !== false, topic: a.topic, categories: bj.categories || [], tags: bj.tags || [], sections, uncertainFacts: bj.uncertain_facts || [], audioUrl: a.audioUrl, videoUrl: a.videoUrl, voiceId: a.audioVoiceId, geo: geoForTopic(a.topic), isGeo: !!geoForTopic(a.topic) };
  }

  private async grokRaw(sys: string, user: string): Promise<string | null> {
    if (!this.key) return null;
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      return String(data?.choices?.[0]?.message?.content || '').trim();
    } catch { return null; }
  }
  private parseArr(s: string | null): string[] | null {
    if (!s) return null;
    try { const v = JSON.parse(s); if (Array.isArray(v)) return v; } catch {}
    const m = s.match(/\[[\s\S]*\]/); if (m) { try { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; } catch {} }
    return null;
  }

  // part: 'title' (кликбейтнее) | 'paragraph' (конкретнее) | 'categories' | 'tags'. Returns the new value; does NOT persist.
  async regeneratePart(id: string, part: string, sectionIdx?: number, paraIdx?: number, current?: string, note?: string, mode?: string, imgIdx?: number): Promise<{ ok: boolean; value?: any; message?: string }> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return { ok: false, message: 'not found' };
    if (part === 'image') {
      if (!this.blobToken) return { ok: false, message: 'нет BLOB_READ_WRITE_TOKEN' };
      const bj0: any = a.bodyJson || {};
      const existing: any[] = Array.isArray(a.imagesJson) && a.imagesJson.length ? a.imagesJson : (a.imageUrl ? [{ url: a.imageUrl }] : []);
      const avoid = new Set(existing.map((x) => x?.url).filter(Boolean));
      const fresh = await this.fetchFreshImage(a.topic, a.slug, avoid, imgIdx ?? existing.length, bj0.image_queries);
      if (!fresh) return { ok: false, message: 'не нашли новое фото (стоки исчерпаны или нет ключей)' };
      return { ok: true, value: fresh };
    }
    if (!this.key) return { ok: false, message: 'нет XAI_API_KEY' };
    const lang = this.langName(a.locale);
    const bj: any = a.bodyJson || {};
    const extra = [
      note && note.trim() ? `Учитывай пожелание редактора: ${note.trim().slice(0, 300)}.` : '',
      mode === 'shorter' ? 'Сделай ЗАМЕТНО КОРОЧЕ — оставь только суть, убери лишнее.' : '',
      mode === 'longer' ? 'Сделай ПОДРОБНЕЕ — добавь конкретику и полезные детали, без воды и повторов.' : '',
    ].filter(Boolean).join(' ');
    if (part === 'title') {
      const sys = `Ты — редактор travel-блога. Перепиши ЗАГОЛОВОК статьи: сделай его более кликбейтным и цепляющим, но честным (без обмана и жёлтизны). ${extra} Язык: ${lang}. Верни ТОЛЬКО текст заголовка, без кавычек и пояснений.`;
      const t = await this.grokRaw(sys, `Тема: ${a.topic}\nТекущий заголовок: ${(current && current.trim()) || a.h1}`);
      if (!t) return { ok: false, message: 'grok failed' };
      return { ok: true, value: t.replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 300) };
    }
    if (part === 'paragraph') {
      const sec = (bj.sections || [])[sectionIdx ?? -1]; if (!sec) return { ok: false, message: 'no section' };
      const paras = String(sec.body || '').split(/\n{2,}/);
      const cur = (current && current.trim()) || paras[paraIdx ?? -1]; if (cur == null) return { ok: false, message: 'no paragraph' };
      const sys = `Ты — редактор travel-блога. Переформулируй абзац: КОНКРЕТНЕЕ, меньше воды, чётче смысл; сохрани факты и язык (${lang}); без клише. ${extra} Верни ТОЛЬКО переписанный абзац.`;
      const t = await this.grokRaw(sys, `Тема: ${a.topic}\nРаздел: ${sec.heading}\nАбзац: ${cur}`);
      if (!t) return { ok: false, message: 'grok failed' };
      return { ok: true, value: t.replace(/^["'«»\s]+|["'«»\s]+$/g, '').trim() };
    }
    if (part === 'categories' || part === 'tags') {
      const spec = part === 'categories' ? '2–4 общих категории' : '4–6 конкретных тегов';
      const sys = `Предложи ${spec} для travel-статьи на языке (${lang}). ${note && note.trim() ? 'Учитывай: ' + note.trim().slice(0, 200) + '.' : ''} Верни СТРОГО JSON-массив строк без markdown.`;
      const arr = this.parseArr(await this.grokRaw(sys, `Тема: ${a.topic}. Заголовок: ${a.h1}.`));
      if (!arr) return { ok: false, message: 'grok failed' };
      return { ok: true, value: arr.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, part === 'categories' ? 4 : 6) };
    }
    return { ok: false, message: 'unknown part' };
  }

  // Persist edits from the inline editor (deleted paragraphs already dropped by the client).
  async applyEdit(id: string, patch: { h1?: string; categories?: string[]; tags?: string[]; sections?: { heading: string; paragraphs: string[] }[]; images?: { url: string; alt?: string; source?: string; sourceUrl?: string }[]; embedImages?: boolean }): Promise<boolean> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return false;
    const bj: any = a.bodyJson || {};
    const sections = Array.isArray(patch.sections)
      ? patch.sections.map((s) => ({ heading: String(s.heading || '').slice(0, 300), body: (s.paragraphs || []).map((p) => String(p || '').trim()).filter(Boolean).join('\n\n') })).filter((s) => s.body || s.heading)
      : bj.sections;
    const newBj = {
      ...bj, sections,
      categories: Array.isArray(patch.categories) ? patch.categories.map((c) => String(c).slice(0, 40)).filter(Boolean).slice(0, 6) : bj.categories,
      tags: Array.isArray(patch.tags) ? patch.tags.map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 10) : bj.tags,
    };
    const images = Array.isArray(patch.images) ? patch.images.filter((i) => i?.url) : undefined;
    const hero = images ? images[0] : undefined;
    await this.prisma.blogArticle.update({
      where: { id },
      data: {
        h1: patch.h1 != null && String(patch.h1).trim() ? String(patch.h1).slice(0, 300) : a.h1,
        bodyJson: newBj as any,
        // reset the article score so the moderator re-scores the edited text
        articleScore: null, articleScoreNote: null,
        ...(typeof patch.embedImages === 'boolean' ? { embedImages: patch.embedImages } : {}),
        ...(images ? {
          imagesJson: images as any,
          imageUrl: hero?.url || null, imageAlt: hero?.alt || null, imageSource: hero?.source || null, imageSourceUrl: hero?.sourceUrl || null,
        } : {}),
      },
    });
    return true;
  }

  // ── Inline part editing for the moderation editor ──
  // A section is either {heading, body} (as generated) or {heading, paragraphs:[{text,deleted}]} (after edit).
  private sectionParagraphs(sec: any): { text: string; deleted: boolean }[] {
    if (Array.isArray(sec?.paragraphs)) return sec.paragraphs.map((p: any) => ({ text: String(p?.text ?? ''), deleted: !!p?.deleted }));
    return String(sec?.body || '').split(/\n{2,}/).map((t) => ({ text: t.trim(), deleted: false })).filter((p) => p.text);
  }
  /** Public paragraphs of a section (excluding deleted) — used by the article render + RSS. */
  paragraphsFor(sec: any): string[] { return this.sectionParagraphs(sec).filter((p) => !p.deleted).map((p) => p.text); }

  async editStructure(id: string): Promise<any | null> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return null;
    const b: any = a.bodyJson || {};
    return {
      id: a.id, slug: a.slug, locale: a.locale, theme: a.theme, topic: a.topic, status: a.status, h1: a.h1,
      categories: b.categories || [], tags: b.tags || [],
      sections: (b.sections || []).map((s: any) => ({ heading: s.heading || '', paragraphs: this.sectionParagraphs(s) })),
    };
  }

  private async grokText(system: string, user: string): Promise<string | null> {
    if (!this.key) return null;
    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      return String(data?.choices?.[0]?.message?.content || '').trim();
    } catch { return null; }
  }
  private parseArray(s: string): any[] { const j = this.parseJson(s); if (Array.isArray(j)) return j; const m = s.match(/\[[\s\S]*\]/); if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) return a; } catch {} } return []; }
  private cleanLine(s: string): string { return String(s).replace(/```[\s\S]*?```/g, '').replace(/^["'«»\s]+|["'«»\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 300); }
  private cleanPara(s: string): string { return String(s).replace(/```[\s\S]*?```/g, '').trim().slice(0, 4000); }

  // Regenerate a single part. part ∈ h1 | categories | tags | heading(si) | paragraph(si,pi).
  async regenerate(id: string, part: string, si?: number, pi?: number): Promise<{ ok: boolean; value?: any }> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return { ok: false };
    const b: any = a.bodyJson || {};
    const ctx = `Тема: ${a.theme}. Направление: ${a.topic}. Язык статьи: ${this.langName(a.locale)}.`;
    const bust = { articleScore: null, articleScoreNote: null }; // content changed → re-score later

    if (part === 'h1') {
      const t = await this.grokText('Ты — редактор заголовков travel-блога. Сделай заголовок БОЛЕЕ КЛИКБЕЙТНЫМ и цепляющим, но честным (без обмана и жёлтых клише). Тот же язык. Верни ТОЛЬКО новый заголовок, одной строкой, без кавычек.', `${ctx}\nТекущий заголовок: ${a.h1}`);
      if (!t) return { ok: false };
      const h1 = this.cleanLine(t);
      await this.prisma.blogArticle.update({ where: { id }, data: { h1, ...bust } }).catch(() => {});
      return { ok: true, value: h1 };
    }
    if (part === 'categories' || part === 'tags') {
      const spec = part === 'categories' ? '2–4 категории' : '4–6 тегов';
      const t = await this.grokText(`Дай ${spec} для статьи НА ЯЗЫКЕ СТАТЬИ (короткие, устоявшиеся: направление/страна/тип отдыха/тема). Верни ТОЛЬКО JSON-массив строк, без markdown.`, `${ctx}\nЗаголовок: ${a.h1}`);
      const arr = this.parseArray(t || '').map((x) => String(x).trim().slice(0, 40)).filter(Boolean);
      if (!arr.length) return { ok: false };
      const val = arr.slice(0, part === 'categories' ? 4 : 6);
      await this.prisma.blogArticle.update({ where: { id }, data: { bodyJson: { ...b, [part]: val } as any } }).catch(() => {});
      return { ok: true, value: val };
    }
    if (part === 'heading' && si != null) {
      const secs = b.sections || []; const sec = secs[si]; if (!sec) return { ok: false };
      const t = await this.grokText('Переформулируй подзаголовок секции: короче и конкретнее, без воды, тот же язык. Верни ТОЛЬКО подзаголовок.', `${ctx}\nПодзаголовок: ${sec.heading || ''}`);
      if (!t) return { ok: false };
      const heading = this.cleanLine(t);
      secs[si] = { heading, paragraphs: this.sectionParagraphs(sec) };
      await this.prisma.blogArticle.update({ where: { id }, data: { bodyJson: { ...b, sections: secs } as any, ...bust } }).catch(() => {});
      return { ok: true, value: heading };
    }
    if (part === 'paragraph' && si != null && pi != null) {
      const secs = b.sections || []; const sec = secs[si]; if (!sec) return { ok: false };
      const paras = this.sectionParagraphs(sec); if (!paras[pi]) return { ok: false };
      const t = await this.grokText('Переформулируй абзац: конкретнее, меньше воды, чётче смысл; сохрани факты и язык, без выдумок. Верни ТОЛЬКО переформулированный абзац.', `${ctx}\nАбзац: ${paras[pi].text}`);
      if (!t) return { ok: false };
      paras[pi] = { text: this.cleanPara(t), deleted: paras[pi].deleted };
      secs[si] = { heading: sec.heading || '', paragraphs: paras };
      await this.prisma.blogArticle.update({ where: { id }, data: { bodyJson: { ...b, sections: secs } as any, ...bust } }).catch(() => {});
      return { ok: true, value: paras[pi].text };
    }
    return { ok: false };
  }

  // Toggle a paragraph's deleted flag (excluded from the public page while deleted).
  async toggleParagraph(id: string, si: number, pi: number, deleted: boolean): Promise<boolean> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return false;
    const b: any = a.bodyJson || {}; const secs = b.sections || []; const sec = secs[si]; if (!sec) return false;
    const paras = this.sectionParagraphs(sec); if (!paras[pi]) return false;
    paras[pi].deleted = !!deleted;
    secs[si] = { heading: sec.heading || '', paragraphs: paras };
    await this.prisma.blogArticle.update({ where: { id }, data: { bodyJson: { ...b, sections: secs } as any } }).catch(() => {});
    return true;
  }

  // ── Public listing + article fetch ──
  // ── Narration (ElevenLabs) + video plumbing ──
  private narrationText(a: any): string {
    const bj: any = a.bodyJson || {};
    const parts: string[] = [String(a.h1 || '')];
    for (const s of (bj.sections || [])) { if (s.heading) parts.push(String(s.heading)); if (s.body) parts.push(String(s.body)); }
    return parts.join('. ').replace(/\s+/g, ' ').trim().slice(0, 5000);
  }

  // List female voices from the ElevenLabs Voice Library (community), ported from SilverFinance.
  async listVoices(langs?: string[]): Promise<{ voices: any[]; error?: string }> {
    const key = this.config.get<string>('VOICE_API_KEY');
    if (!key) return { voices: [], error: 'VOICE_API_KEY не задан (ключ ElevenLabs)' };
    const list = (langs && langs.length) ? langs : [''];
    const byId = new Map<string, any>();
    for (const language of list) {
      const params = new URLSearchParams({ gender: 'female', page_size: '100' });
      if (language) params.set('language', language);
      try {
        const res = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`, { headers: { 'xi-api-key': key } });
        if (!res.ok) continue;
        const d: any = await res.json();
        for (const v of (d.voices || [])) {
          const id = String(v.voice_id ?? v.voiceId ?? '');
          if (id && !byId.has(id)) byId.set(id, { voice_id: id, name: String(v.name ?? 'Voice'), preview_url: v.preview_url ?? v.previewUrl ?? null, accent: v.accent ?? null });
        }
      } catch { /* try next language */ }
    }
    const voices = [...byId.values()];
    return voices.length ? { voices } : { voices: [], error: 'ElevenLabs вернул 0 голосов (возможно, нужен тариф с Voice Library)' };
  }

  // Synthesize the article narration and store the mp3 in Vercel Blob.
  async synthAudio(id: string, voiceId?: string): Promise<{ audioUrl?: string; error?: string }> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return { error: 'not found' };
    const key = this.config.get<string>('VOICE_API_KEY');
    if (!key) return { error: 'VOICE_API_KEY не задан (ключ ElevenLabs)' };
    if (!this.blobToken) return { error: 'BLOB_READ_WRITE_TOKEN не задан' };
    const text = this.narrationText(a);
    if (!text) return { error: 'пустой текст статьи' };
    const vid = (voiceId && voiceId.trim()) || a.audioVoiceId || this.config.get<string>('VOICE_ID') || 'EXAVITQu4vr4xnSDxMaL';
    const model = this.config.get<string>('VOICE_MODEL') || 'eleven_flash_v2_5';
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
        body: JSON.stringify({ text, model_id: model, output_format: 'mp3_44100_128' }),
      });
      if (!res.ok) return { error: `ElevenLabs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
      const buf = Buffer.from(await res.arrayBuffer());
      const { put } = await import('@vercel/blob');
      const blob = await put(`blog/audio/${a.slug}.mp3`, buf, { access: 'public', token: this.blobToken, contentType: 'audio/mpeg', addRandomSuffix: true });
      await this.prisma.blogArticle.update({ where: { id }, data: { audioUrl: blob.url, audioVoiceId: vid } }).catch(() => {});
      return { audioUrl: blob.url };
    } catch (e: any) { return { error: `Ошибка ElevenLabs: ${e?.message || e}` }; }
  }

  async saveVideo(id: string, videoUrl: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(videoUrl || '')) return false;
    await this.prisma.blogArticle.update({ where: { id }, data: { videoUrl } }).catch(() => {});
    return true;
  }

  // Assets for the montage page (title + slides + narration).
  async mediaFor(id: string): Promise<any | null> {
    const a = await this.prisma.blogArticle.findUnique({ where: { id } }).catch(() => null);
    if (!a) return null;
    const bj: any = a.bodyJson || {};
    const subtitles: string[] = [];
    for (const s of (bj.sections || [])) String(s.body || '').split(/\n{2,}/).forEach((p: string) => { const t = p.trim(); if (t) subtitles.push(t); });
    const imgs = (Array.isArray(a.imagesJson) ? (a.imagesJson as any[]).map((x) => x?.url).filter(Boolean) : []);
    const images = imgs.length ? imgs : (a.imageUrl ? [a.imageUrl] : []);
    const geo = geoForTopic(a.topic);
    return { id: a.id, slug: a.slug, h1: a.h1, locale: a.locale, topic: a.topic, image: a.imageUrl, images, subtitles, audioUrl: a.audioUrl, videoUrl: a.videoUrl, voiceId: a.audioVoiceId, geo, isGeo: !!geo };
  }

  async list(limit = 60): Promise<any[]> {
    const rows = await this.prisma.blogArticle.findMany({ where: { status: 'published' }, orderBy: { publishedAt: 'desc' }, take: limit });
    return rows.map((a) => ({ slug: a.slug, h1: a.h1, theme: a.theme, themeLabel: themeLabel(a.theme, a.locale), topic: a.topic, locale: a.locale, image: a.imageUrl, imageAlt: a.imageAlt, meta: a.metaDescription, publishedAt: a.publishedAt }));
  }
  async bySlug(slug: string) { return this.prisma.blogArticle.findUnique({ where: { slug } }).catch(() => null); }
  async bumpView(id: string) { await this.prisma.blogArticle.update({ where: { id }, data: { views: { increment: 1 } } }).catch(() => {}); }

  private escX(s: any) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  private cdata(s: any) { return `<![CDATA[${String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`; }

  // RSS 2.0 with full article HTML for aggregators (Dzen ingests via content:encoded / yandex:full-text).
  async rssXml(locale?: string): Promise<string> {
    const where: any = { status: 'published' };
    if (locale) where.locale = locale.toLowerCase();
    const rows = await this.prisma.blogArticle.findMany({ where, orderBy: { publishedAt: 'desc' }, take: 50 }).catch(() => [] as any[]);
    const items = rows.map((a) => {
      const link = `${this.baseUrl}/blog/${a.slug}`;
      const html = ((a.bodyJson as any)?.sections || []).map((s: any) =>
        `<h2>${this.escX(s.heading)}</h2>` + String(s.body || '').split(/\n{2,}/).map((p: string) => `<p>${this.escX(p)}</p>`).join('')).join('');
      const full = (a.imageUrl ? `<img src="${this.escX(a.imageUrl)}" alt="${this.escX(a.imageAlt || a.h1)}"/>` : '') + html;
      const enclosure = a.imageUrl ? `<enclosure url="${this.escX(a.imageUrl)}" type="image/jpeg"/><media:content url="${this.escX(a.imageUrl)}" medium="image"/>` : '';
      return `<item>\n<title>${this.cdata(a.h1)}</title>\n<link>${link}</link>\n<guid isPermaLink="true">${link}</guid>\n` +
        `<pubDate>${new Date(a.publishedAt || a.createdAt).toUTCString()}</pubDate>\n<category>${this.cdata(themeLabel(a.theme, a.locale))}</category>\n` +
        `<author>${this.cdata(a.authorName || 'ATM-travel')}</author>\n<description>${this.cdata(a.metaDescription || '')}</description>\n` +
        `<content:encoded>${this.cdata(full)}</content:encoded>\n<yandex:full-text>${this.cdata(full)}</yandex:full-text>\n${enclosure}\n</item>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:yandex="http://news.yandex.ru" xmlns:media="http://search.yahoo.com/mrss/">\n` +
      `<channel>\n<title>Блог ATM-travel</title>\n<link>${this.baseUrl}/blog</link>\n` +
      `<description>Тревел-гайды, советы, обзоры и истории о направлениях.</description>\n<language>${locale || 'ru'}</language>\n${items}\n</channel>\n</rss>`;
  }

  async sitemapXml(): Promise<string> {
    const rows = await this.prisma.blogArticle.findMany({ where: { status: 'published' }, select: { slug: true, updatedAt: true }, orderBy: { publishedAt: 'desc' }, take: 5000 }).catch(() => [] as any[]);
    const urls = rows.map((a) => `<url><loc>${this.baseUrl}/blog/${a.slug}</loc><lastmod>${new Date(a.updatedAt).toISOString()}</lastmod></url>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${this.baseUrl}/blog</loc></url>${urls}</urlset>`;
  }
}
