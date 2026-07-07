import { Body, Controller, Get, Headers, Param, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { BlogService } from './blog.service';
import { themeLabel } from './blog-templates';

@Controller()
export class BlogController {
  constructor(private readonly svc: BlogService, private readonly config: ConfigService) {}

  private adminOk(key?: string) { const t = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN'); return !!t && key === t; }
  private cronOk(auth?: string, xsec?: string) { const s = this.config.get<string>('CRON_SECRET'); return !!s && (auth === `Bearer ${s}` || xsec === s); }
  private esc(s: any) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]); }

  // Public listing data (consumed by /blog page).
  @Get('api/blog/list')
  async list() { return { articles: await this.svc.list() }; }

  // Admin: drafts + needs_manual with article & photo scores.
  @Get('api/blog/drafts')
  async drafts(@Query('key') key?: string) {
    if (!this.adminOk(key)) throw new UnauthorizedException('bad token');
    return { drafts: await this.svc.drafts() };
  }
  @Post('api/blog/publish')
  async publish(@Body() body: { id?: string; key?: string }) {
    if (!this.adminOk(body?.key)) throw new UnauthorizedException('bad token');
    return { ok: body?.id ? await this.svc.publish(body.id) : false };
  }
  @Post('api/blog/reject')
  async reject(@Body() body: { id?: string; key?: string }) {
    if (!this.adminOk(body?.key)) throw new UnauthorizedException('bad token');
    return { ok: body?.id ? await this.svc.reject(body.id) : false };
  }

  // Inline editor: load the full editable structure.
  @Get('api/blog/article')
  async articleEdit(@Query('key') key: string, @Query('id') id: string) {
    if (!this.adminOk(key)) throw new UnauthorizedException('bad token');
    return { article: await this.svc.articleForEdit(id || '') };
  }
  // Regenerate one part (title=кликбейтнее, paragraph=конкретнее, categories, tags). Returns the new value; no persist.
  @Post('api/blog/regenerate')
  async regenerate(@Body() b: { key?: string; id?: string; part?: string; sectionIdx?: number; paraIdx?: number; current?: string; note?: string; mode?: string; imgIdx?: number }) {
    if (!this.adminOk(b?.key)) throw new UnauthorizedException('bad token');
    return this.svc.regeneratePart(b?.id || '', b?.part || '', b?.sectionIdx, b?.paraIdx, b?.current, b?.note, b?.mode, b?.imgIdx);
  }
  // Persist edits (title/categories/tags/sections/images; deleted paragraphs/images already removed by the client).
  @Post('api/blog/edit')
  async edit(@Body() b: { key?: string; id?: string; h1?: string; categories?: string[]; tags?: string[]; sections?: any[]; images?: any[] }) {
    if (!this.adminOk(b?.key)) throw new UnauthorizedException('bad token');
    return { ok: await this.svc.applyEdit(b?.id || '', { h1: b?.h1, categories: b?.categories, tags: b?.tags, sections: b?.sections, images: b?.images }) };
  }

  // ── Blog media: ElevenLabs voices/narration + rendered video ──
  @Get('api/blog/voices')
  async voices(@Query('key') key?: string, @Query('lang') lang?: string) {
    if (!this.adminOk(key)) throw new UnauthorizedException('bad token');
    const langs = (lang || '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.svc.listVoices(langs);
  }
  @Post('api/blog/audio')
  async audio(@Body() b: { key?: string; id?: string; voiceId?: string }) {
    if (!this.adminOk(b?.key)) throw new UnauthorizedException('bad token');
    return this.svc.synthAudio(b?.id || '', b?.voiceId);
  }
  @Get('api/blog/media')
  async media(@Query('key') key?: string, @Query('id') id?: string) {
    if (!this.adminOk(key)) throw new UnauthorizedException('bad token');
    const m = id ? await this.svc.mediaFor(id) : null;
    return m ? { ok: true, media: m } : { ok: false };
  }
  @Post('api/blog/video')
  async video(@Body() b: { key?: string; id?: string; videoUrl?: string }) {
    if (!this.adminOk(b?.key)) throw new UnauthorizedException('bad token');
    return { ok: b?.id && b?.videoUrl ? await this.svc.saveVideo(b.id, b.videoUrl) : false };
  }

  // Cron: generate one article per run (pg_cron target; also runs from the daily refresh).
  @Post('api/blog/generate')
  async genPost(@Query('key') key?: string, @Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.cronOk(auth, xsec) && !this.adminOk(key)) throw new UnauthorizedException('bad cron secret / admin token');
    return { ok: true, generated: (await this.svc.generateOne()) ? 1 : 0 };
  }
  @Get('api/blog/generate')
  async genGet(@Query('key') key?: string, @Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.cronOk(auth, xsec) && !this.adminOk(key)) throw new UnauthorizedException('bad cron secret / admin token');
    return { ok: true, generated: (await this.svc.generateOne()) ? 1 : 0 };
  }

  @Get('sitemap-blog.xml')
  async sitemap(@Res() res: Response) { res.type('application/xml').send(await this.svc.sitemapXml()); }

  // RSS feed (Dzen channel). Optional ?lang=ru|uk|en|de for a single-language feed.
  @Get('blog/rss.xml')
  async rss(@Query('lang') lang: string, @Res() res: Response) {
    res.type('application/rss+xml').send(await this.svc.rssXml((lang || '').toLowerCase()));
  }

  // Server-rendered article page (SEO: title/meta/canonical + Article schema).
  @Get('blog/:slug')
  async article(@Param('slug') slug: string, @Query('key') key: string, @Res() res: Response) {
    const a = await this.svc.bySlug(slug);
    const preview = this.adminOk(key);
    if (!a || (a.status !== 'published' && !preview)) {
      return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>404</title><p>Article not found / Статья не найдена. <a href="/blog">Блог</a></p>');
    }
    if (!preview && a.status === 'published') await this.svc.bumpView(a.id);
    res.type('html').send(this.renderArticle(a));
  }

  private labels(locale?: string) {
    const L: Record<string, any> = {
      ru: { back: '← Все статьи блога', disc: 'Статья носит справочный характер; правила въезда, цены и расписания уточняйте в официальных источниках.', sources: 'Источники:', loc: 'ru-RU' },
      uk: { back: '← Усі статті блогу', disc: 'Стаття має довідковий характер; правила в’їзду, ціни й розклади уточнюйте в офіційних джерелах.', sources: 'Джерела:', loc: 'uk-UA' },
      en: { back: '← All blog articles', disc: 'This article is for reference; verify entry rules, prices and schedules with official sources.', sources: 'Sources:', loc: 'en-GB' },
      de: { back: '← Alle Blogartikel', disc: 'Dieser Artikel dient zur Orientierung; Einreiseregeln, Preise und Fahrpläne bitte in offiziellen Quellen prüfen.', sources: 'Quellen:', loc: 'de-DE' },
    };
    return L[(locale || 'ru').toLowerCase()] || L.en;
  }

  // Category chips: prioritize existing service categories (the localized theme) then the article's own tags. Cap 3.
  private articleCategories(a: any): string[] {
    const out: string[] = [themeLabel(a.theme, a.locale)];
    for (const c of (a.bodyJson?.categories || [])) {
      const v = String(c || '').trim().slice(0, 40);
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
      if (out.length >= 3) break;
    }
    return out.slice(0, 3);
  }

  // Sources: keep only real, trusted-domain https links; cap 3.
  private articleSources(a: any): { title: string; url: string; host: string }[] {
    const TRUST = ['wikipedia.org', 'wikivoyage.org', 'wikimedia.org', 'wikitravel.org', 'unesco.org', 'britannica.com', 'lonelyplanet.com', 'nationalgeographic.com', 'tripadvisor.com', 'atlasobscura.com'];
    const out: { title: string; url: string; host: string }[] = [];
    for (const s of (a.bodyJson?.sources || [])) {
      try {
        const u = new URL(String(s?.url || ''));
        if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (!TRUST.some((d) => host === d || host.endsWith('.' + d))) continue;
        if (out.some((o) => o.url === u.toString())) continue;
        out.push({ title: String(s?.title || host).slice(0, 80), url: u.toString(), host });
      } catch { /* skip bad url */ }
      if (out.length >= 3) break;
    }
    return out;
  }

  private renderArticle(a: any): string {
    const AL = this.labels(a.locale);
    const cats = this.articleCategories(a);
    const sources = this.articleSources(a);
    const gallery: { url: string; alt?: string }[] = (Array.isArray(a.imagesJson) ? a.imagesJson.slice(1) : []).filter((x: any) => x?.url);
    const sectionsHtml = (a.bodyJson?.sections || []).map((s: any) =>
      `<h2>${this.esc(s.heading)}</h2>` + String(s.body || '').split(/\n{2,}/).map((p: string) => `<p>${this.esc(p)}</p>`).join(''));
    const body = this.interleave(sectionsHtml, gallery);
    const hero = a.imageUrl ? `<img class="hero" src="${this.esc(a.imageUrl)}" alt="${this.esc(a.imageAlt || a.h1)}" loading="eager">` : '';
    const credit = a.imageSource ? `<div class="credit">Фото: <a href="${this.esc(a.imageSourceUrl || '#')}" rel="nofollow noopener">${this.esc(a.imageSource)}</a></div>` : '';
    const catsHtml = cats.length ? `<div class="cats">${cats.map((c) => `<span class="cat">${this.esc(c)}</span>`).join('')}</div>` : '';
    const dateStr = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString(AL.loc) : '';
    const sourcesHtml = sources.length
      ? `<div class="sources"><span class="sh">${AL.sources}</span>${sources.map((s) => `<a href="${this.esc(s.url)}" rel="nofollow noopener" target="_blank"><img src="https://icons.duckduckgo.com/ip3/${this.esc(s.host)}.ico" alt="" loading="lazy" onerror="this.style.display='none'">${this.esc(s.title)}</a>`).join('')}</div>`
      : '';
    const schema = {
      '@context': 'https://schema.org', '@type': 'Article', headline: a.h1,
      datePublished: a.publishedAt, dateModified: a.updatedAt,
      image: a.imageUrl ? [a.imageUrl, ...gallery.map((g) => g.url)] : undefined,
      author: { '@type': 'Person', name: a.authorName || 'ATM-travel' },
      publisher: { '@type': 'Organization', name: 'ATM-travel' },
      articleSection: cats[0], keywords: [...cats, ...((a.bodyJson?.tags) || [])].join(', '),
      citation: sources.map((s) => s.url),
    };
    // The editor-review note is an internal drafting aid — never show it once the article is live.
    const uncertain = a.status !== 'published' && (a.bodyJson?.uncertain_facts || []).length
      ? `<aside class="note"><b>Редактору проверить:</b><ul>${a.bodyJson.uncertain_facts.map((u: string) => `<li>${this.esc(u)}</li>`).join('')}</ul></aside>` : '';
    return `<!doctype html><html lang="${a.locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.esc(a.h1)}</title>
<meta name="description" content="${this.esc(a.metaDescription)}">
<link rel="canonical" href="${this.esc(this.baseUrl())}/blog/${a.slug}">
<meta property="og:type" content="article"><meta property="og:title" content="${this.esc(a.h1)}">
<meta property="og:description" content="${this.esc(a.metaDescription)}">${a.imageUrl ? `<meta property="og:image" content="${this.esc(a.imageUrl)}">` : ''}
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#f6f8fa;color:#111;font:17px/1.65 Georgia,'Times New Roman',serif}
  .wrap{max-width:760px;margin:0 auto;padding:22px 18px 60px}
  h1{font-size:30px;line-height:1.2;margin:.3em 0 .25em}
  h2{font-size:22px;margin:1.4em 0 .3em}
  .cats{display:flex;gap:6px;flex-wrap:wrap;font-family:system-ui,sans-serif;margin:.2em 0 .35em}
  .cat{font-size:11px;letter-spacing:.3px;text-transform:uppercase;color:#0e7c86;background:#e6f4f6;border-radius:999px;padding:3px 10px;font-weight:700}
  .pubdate{font-family:system-ui,sans-serif;color:#8a97a3;font-size:13px;margin-bottom:16px}
  .hero{width:100%;height:auto;border-radius:12px;margin:10px 0 4px;display:block}
  .inline-img{width:75%;height:auto;border-radius:10px;display:block;margin:1.4em auto}
  .credit{font-family:system-ui,sans-serif;font-size:11px;color:#8a97a3;margin-bottom:10px}
  p{margin:.7em 0}
  a{color:#0e7c86}
  .back{font-family:system-ui,sans-serif;font-size:14px;display:inline-block;margin-bottom:10px}
  .note{background:#fff8e6;border:1px solid #f0e0b0;border-radius:10px;padding:10px 14px;font-family:system-ui,sans-serif;font-size:13px;color:#6b5b16;margin:18px 0}
  .sources{font-family:system-ui,sans-serif;font-size:12px;color:#8a97a3;border-top:1px solid #e6e9ee;margin-top:24px;padding-top:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
  .sources .sh{color:#66707a;font-weight:600}
  .sources a{color:#5c6b7a;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .sources a:hover{color:#0e7c86;text-decoration:underline}
  .sources img{width:14px;height:14px;border-radius:3px;display:block}
  .disc{font-family:system-ui,sans-serif;font-size:12px;color:#8a97a3;border-top:1px solid #e6e9ee;margin-top:16px;padding-top:12px}
</style></head><body><div class="wrap">
<a class="back" href="/blog">${AL.back}</a>
<h1>${this.esc(a.h1)}</h1>
${catsHtml}
<div class="pubdate">${this.esc(a.authorName || 'ATM-travel')} · ${dateStr}</div>
${hero}${credit}
${body}
${uncertain}
${sourcesHtml}
<div class="disc">${AL.disc}</div>
</div></body></html>`;
  }
  private baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || 'https://atm-travel.org').replace(/\/$/, ''); }

  // Spread gallery images evenly across the gaps between rendered sections (never before the first section).
  // Hero stays full-size (.hero, unchanged); these render at 75% width (.inline-img).
  private interleave(sections: string[], gallery: { url: string; alt?: string }[]): string {
    if (!gallery.length || sections.length < 2) return sections.join('\n') + gallery.map((g) => this.inlineImg(g)).join('');
    const gaps = sections.length - 1;
    const step = gaps / Math.min(gallery.length, gaps) || 1;
    const out: string[] = [sections[0]];
    let gi = 0;
    for (let i = 1; i < sections.length; i++) {
      if (gi < gallery.length && i >= Math.round(gi * step) + 1) { out.push(this.inlineImg(gallery[gi])); gi++; }
      out.push(sections[i]);
    }
    while (gi < gallery.length) { out.push(this.inlineImg(gallery[gi])); gi++; }   // any leftovers go at the end
    return out.join('\n');
  }
  private inlineImg(g: { url: string; alt?: string }): string {
    return `<img class="inline-img" src="${this.esc(g.url)}" alt="${this.esc(g.alt || '')}" loading="lazy">`;
  }
}
