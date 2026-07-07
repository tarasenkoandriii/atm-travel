import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { HotToursService } from './hottours.service';

@Controller()
export class HotToursController {
  constructor(private readonly svc: HotToursService) {}

  // Accordion data for /hot-tours (countries → price/date range → article list).
  @Get('api/hot-tours')
  async list() {
    await this.svc.ensureFxRate();
    return { countries: await this.svc.accordion(), fx: this.svc.fxTable };
  }

  // Human-gate admin: list drafts/needs_manual (with competitiveness rating). Token-gated.
  @Get('api/hot-tours/drafts')
  async drafts(@Query('key') key?: string) {
    if (!this.svc.adminAllowed(key)) throw new UnauthorizedException();
    return { drafts: await this.svc.drafts() };
  }

  @Post('api/hot-tours/publish')
  async publish(@Body() body: { id?: string; key?: string }) {
    if (!this.svc.adminAllowed(body?.key)) throw new UnauthorizedException();
    const ok = body?.id ? await this.svc.publish(body.id) : false;
    return { ok };
  }

  // Inline editor (admin): same editing toolkit as the blog editor (title/paragraph regen, drag-reorder, save).
  @Get('api/hot-tours/article')
  async articleForEdit(@Query('id') id?: string, @Query('key') key?: string) {
    if (!this.svc.adminAllowed(key)) throw new UnauthorizedException();
    const a = id ? await this.svc.articleForEdit(id) : null;
    return a ? { ok: true, article: a } : { ok: false };
  }
  @Post('api/hot-tours/edit')
  async editArticle(@Body() b: { key?: string; id?: string; h1?: string; sections?: { heading: string; paragraphs: string[] }[] }) {
    if (!this.svc.adminAllowed(b?.key)) throw new UnauthorizedException();
    return { ok: b?.id ? await this.svc.applyEdit(b.id, { h1: b.h1, sections: b.sections }) : false };
  }
  @Post('api/hot-tours/regenerate')
  async regenerate(@Body() b: { key?: string; id?: string; part?: string; sectionIdx?: number; paraIdx?: number; current?: string; note?: string; mode?: string }) {
    if (!this.svc.adminAllowed(b?.key)) throw new UnauthorizedException();
    return this.svc.regeneratePart(b?.id || '', b?.part || '', b?.sectionIdx, b?.paraIdx, b?.current, b?.note, b?.mode);
  }

  @Get('api/hot-tours/stats')
  async stats(@Query('key') key?: string) {
    if (!this.svc.adminAllowed(key)) throw new UnauthorizedException();
    return this.svc.stats();
  }

  @Get('api/hot-tours/retention')
  async retention(@Query('key') key?: string) {
    if (!this.svc.adminAllowed(key)) throw new UnauthorizedException();
    return this.svc.retention();
  }

  // Take a weekly subscriber-state snapshot (CRON_SECRET-guarded; idempotent per week).
  @Post('api/hot-tours/snapshot-subscribers')
  async snapshotPost(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) throw new UnauthorizedException('Invalid cron secret');
    return this.svc.snapshotSubscribers();
  }
  @Get('api/hot-tours/snapshot-subscribers')
  async snapshotGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) throw new UnauthorizedException('Invalid cron secret');
    return this.svc.snapshotSubscribers();
  }

  // Generate a small batch of draft articles on demand (hourly pg_cron tick). CRON_SECRET-guarded.
  // ?ingest=1 also refreshes the feed (ingest + expiry) before generating.
  @Post('api/hot-tours/generate')
  async generatePost(@Query('ingest') ingest?: string, @Query('key') key?: string, @Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec) && !this.svc.adminAllowed(key)) throw new UnauthorizedException('Invalid cron secret / admin token');
    return { ok: true, ...(await this.svc.generateTick(ingest === '1' || ingest === 'true')) };
  }
  @Get('api/hot-tours/generate')
  async generateGet(@Query('ingest') ingest?: string, @Query('key') key?: string, @Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec) && !this.svc.adminAllowed(key)) throw new UnauthorizedException('Invalid cron secret / admin token');
    return { ok: true, ...(await this.svc.generateTick(ingest === '1' || ingest === 'true')) };
  }

  @Get('sitemap.xml')
  async sitemap(@Res() res: Response) {
    res.type('application/xml').send(await this.svc.sitemapXml('sitemap'));
  }

  @Get('sitemap-news.xml')
  async sitemapNews(@Res() res: Response) {
    res.type('application/xml').send(await this.svc.sitemapXml('sitemap-news'));
  }

  @Get('robots.txt')
  robots(@Res() res: Response) {
    res.type('text/plain').send(this.svc.robotsTxt());
  }

  // Click-tracking redirect for the sponsored CTA: log the click → 302 to the affiliate link.
  @Get('go/hot-tour/:slug')
  async go(@Param('slug') slug: string, @Query('s') s: string, @Req() req: Request, @Res() res: Response) {
    const url = await this.svc.trackClick(slug, req.headers['referer'] as string, req.headers['user-agent'] as string, s || '');
    return res.redirect(302, url || '/hot-tours');
  }

  // 1x1 transparent GIF for email open tracking.
  private static readonly PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  @Get('px/o')
  async pxOpen(@Query('c') c: string, @Res() res: Response) {
    await this.svc.trackEmailOpen(c || '');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' });
    return res.end(HotToursController.PX);
  }
  // Client view ping (sub-tagged) — same tiny GIF.
  @Get('px/v')
  async pxView(@Query('slug') slug: string, @Query('s') s: string, @Res() res: Response) {
    await this.svc.trackView(slug || '', s || '');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    return res.end(HotToursController.PX);
  }

  // Weekly effectiveness digest to the site owner (CRON_SECRET-guarded).
  @Post('api/hot-tours/admin-digest')
  async adminDigestPost(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) throw new UnauthorizedException('Invalid cron secret');
    return this.svc.adminDigest();
  }
  @Get('api/hot-tours/admin-digest')
  async adminDigestGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) throw new UnauthorizedException('Invalid cron secret');
    return this.svc.adminDigest();
  }

  // Server-rendered article page (SEO: title/meta/canonical + Article schema + sponsored CTA).
  @Get('go/tour/:tourId')
  async goTour(@Param('tourId') tourId: string, @Query('u') u: string, @Query('c') c: string, @Query('s') s: string, @Res() res: Response) {
    const url = await this.svc.trackTourClick(tourId, u || 'site', c || '', s || '');
    return res.redirect(302, url);
  }

  @Get('hot-tours/:slug')
  async article(@Param('slug') slug: string, @Query('key') key: string, @Res() res: Response) {
    const preview = this.svc.adminAllowed(key);
    const a = preview ? await this.svc.articleAnyStatus(slug) : await this.svc.articleBySlug(slug);
    if (!a) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>404</title><p>Tour not found / Тур не найден. <a href="/hot-tours">All hot tours</a></p>');
    await this.svc.ensureFxRate();
    if (!preview && a.status === 'published') await this.svc.bumpView(a.id, a.slug);
    res.type('html').send(this.renderArticle(a));
  }

  private esc(s: any): string {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }

  // Article chrome labels localized by the article's locale (body itself is generated in that locale).
  private artLabels(locale?: string): { back: string; flight: string; nights: string; depart: string; view: string; photo: string; disc: string; loc: string } {
    const L: Record<string, any> = {
      ru: { back: '← Горящие туры', flight: 'Перелёт', nights: 'ноч.', depart: 'вылет', view: 'Смотреть тур →', photo: 'Фото', disc: 'Ссылка на бронирование — партнёрская. Цена и наличие актуальны на момент публикации и могут измениться.', loc: 'uk-UA' },
      uk: { back: '← Гарячі тури', flight: 'Переліт', nights: 'ноч.', depart: 'виліт', view: 'Дивитися тур →', photo: 'Фото', disc: 'Посилання на бронювання — партнерське. Ціна та наявність актуальні на момент публікації й можуть змінитися.', loc: 'uk-UA' },
      en: { back: '← Hot tours', flight: 'Flight', nights: 'nights', depart: 'departs', view: 'View tour →', photo: 'Photo', disc: 'The booking link is affiliate. Price and availability are as of publication and may change.', loc: 'en-GB' },
      pl: { back: '← Gorące oferty', flight: 'Lot', nights: 'nocy', depart: 'wylot', view: 'Zobacz wycieczkę →', photo: 'Zdjęcie', disc: 'Link do rezerwacji jest afiliacyjny. Cena i dostępność aktualne na moment publikacji i mogą się zmienić.', loc: 'pl-PL' },
      fr: { back: '← Séjours de dernière minute', flight: 'Vol', nights: 'nuits', depart: 'départ', view: 'Voir le séjour →', photo: 'Photo', disc: 'Le lien de réservation est affilié. Le prix et la disponibilité sont ceux de la publication et peuvent changer.', loc: 'fr-FR' },
      de: { back: '← Last-Minute', flight: 'Flug', nights: 'Nächte', depart: 'Abflug', view: 'Reise ansehen →', photo: 'Foto', disc: 'Der Buchungslink ist ein Affiliate-Link. Preis und Verfügbarkeit gelten zum Zeitpunkt der Veröffentlichung und können sich ändern.', loc: 'de-DE' },
      ja: { back: '← お得なツアー', flight: '航空券', nights: '泊', depart: '出発', view: 'ツアーを見る →', photo: '写真', disc: '予約リンクはアフィリエイトです。価格と空き状況は公開時点のもので、変更される場合があります。', loc: 'ja-JP' },
      it: { back: '← Last minute', flight: 'Volo', nights: 'notti', depart: 'partenza', view: 'Vedi il viaggio →', photo: 'Foto', disc: 'Il link di prenotazione è di affiliazione. Prezzo e disponibilità sono al momento della pubblicazione e possono variare.', loc: 'it-IT' },
      pt: { back: '← Promoções', flight: 'Voo', nights: 'noites', depart: 'partida', view: 'Ver viagem →', photo: 'Foto', disc: 'O link de reserva é de afiliado. Preço e disponibilidade são os da publicação e podem mudar.', loc: 'pt-PT' },
      es: { back: '← Ofertas', flight: 'Vuelo', nights: 'noches', depart: 'salida', view: 'Ver viaje →', photo: 'Foto', disc: 'El enlace de reserva es de afiliado. El precio y la disponibilidad son los de la publicación y pueden cambiar.', loc: 'es-ES' },
    };
    return L[(locale || 'ru').toLowerCase()] || L.en;
  }

  private renderArticle(a: any): string {
    const t = a.tour;
    const AL = this.artLabels(a.locale);
    const gallery: { url: string; alt?: string }[] = (Array.isArray(a.imagesJson) ? a.imagesJson.slice(1) : []).filter((x: any) => x?.url);
    const sectionsHtml = (a.bodyJson?.sections || []).map((s: any) =>
      `<h2>${this.esc(s.heading)}</h2>` + String(s.body || '').split(/\n{2,}/).map((p: string) => `<p>${this.esc(p)}</p>`).join(''));
    const body = this.interleave(sectionsHtml, gallery);
    const pp = this.svc.priceBlock(a.locale, t.priceUAH);
    const oldPp = t.oldPriceUAH ? this.svc.priceBlock(a.locale, t.oldPriceUAH) : null;
    const old = oldPp ? `<s>${this.esc(oldPp.main)}</s> ` : '';
    const date = new Date(t.departureDate).toLocaleDateString(AL.loc);
    const dt = new Date(t.departureDate).toISOString().slice(0, 10);
    const schema = {
      '@context': 'https://schema.org', '@type': 'Article', headline: a.h1,
      datePublished: a.publishedAt, dateModified: a.updatedAt,
      author: { '@type': 'Person', name: a.authorName || 'ATM-travel' },
      publisher: { '@type': 'Organization', name: 'ATM-travel' },
    };
    const offer = {
      '@context': 'https://schema.org', '@type': 'Offer', priceCurrency: pp.code, price: pp.amount,
      availabilityStarts: dt, url: '/go/hot-tour/' + a.slug,
    };
    // The editor-review note is an internal drafting aid — never show it once the article is live.
    const uncertain = a.status !== 'published' && (a.bodyJson?.uncertain_facts || []).length
      ? `<aside class="ht-note"><b>Редактору проверить:</b><ul>${a.bodyJson.uncertain_facts.map((u: string) => `<li>${this.esc(u)}</li>`).join('')}</ul></aside>` : '';
    return `<!doctype html><html lang="${a.locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.esc(a.h1)}</title>
<meta name="description" content="${this.esc(a.metaDescription)}">
<link rel="canonical" href="/hot-tours/${a.slug}">
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<script type="application/ld+json">${JSON.stringify(offer)}</script>
<style>body{margin:0;background:#070c12;color:#e7eef4;font:16px/1.65 system-ui,-apple-system,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:24px 18px 80px}a{color:#4fd7e0}
h1{font-size:26px;line-height:1.25}h2{font-size:19px;margin-top:26px}
.byline{color:#7d8b99;font-size:13px;margin:6px 0 18px}
.ht-hero{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px;margin:2px 0 6px}
.ht-inline{width:75%;aspect-ratio:16/9;object-fit:cover;border-radius:10px;margin:20px auto;display:block}
.ht-credit{color:#5c6b7a;font-size:11px;margin:0 0 14px}.ht-credit a{color:#7d8b99}
.ht-price{border:1px solid #1b2734;background:#0b131c;border-radius:12px;padding:16px;margin:22px 0}
.ht-price .p{font-size:24px;font-weight:800;color:#4fd7e0}
.ht-price .ht-usd{font-size:14px;font-weight:600;color:#7d8b99;margin-left:6px}
.ht-cta{display:inline-block;margin-top:10px;background:#12324a;border:1px solid #256e74;color:#4fd7e0;
text-decoration:none;border-radius:10px;padding:11px 18px;font-weight:700}
.ht-note{border:1px dashed #5b4620;background:rgba(224,166,58,.07);color:#e0a63a;border-radius:10px;padding:12px;margin:20px 0;font-size:13px}
.ht-disc{color:#7d8b99;font-size:12px;margin-top:26px}</style></head>
<body><div class="wrap">
<p><a href="/hot-tours">${AL.back}</a></p>
<h1>${this.esc(a.h1)}</h1>
<div class="byline">${this.esc(a.authorName || 'ATM-travel')} · ${a.publishedAt ? new Date(a.publishedAt).toLocaleDateString(AL.loc) : ''}</div>
${a.imageUrl ? `<img class="ht-hero" src="${this.esc(a.imageUrl)}" alt="${this.esc(a.imageAlt || a.h1)}" loading="lazy">${a.imageSource === 'pexels' ? `<div class="ht-credit">${AL.photo}: <a href="${this.esc(a.imageSourceUrl)}" target="_blank" rel="noopener">Pexels</a></div>` : ''}` : ''}
${body}
<div class="ht-price">
  <div>${t.hotelName ? this.esc(t.hotelName) + ' · ' + t.hotelStars + '★ · ' : AL.flight + ' · '}${this.esc(t.destinationCity)}, ${this.esc(t.destinationCountry)}</div>
  <div class="p">${old}${this.esc(pp.main)}${pp.note ? ' <span class="ht-usd">' + this.esc(pp.note) + '</span>' : ''}</div>
  <div>${t.nights} ${AL.nights} · ${AL.depart} ${this.esc(t.departureCity)} ${date}${t.discountPct ? ' · −' + t.discountPct + '%' : ''}</div>
  <a class="ht-cta" id="htCta" href="/go/hot-tour/${a.slug}" target="_blank" rel="nofollow sponsored noopener">${AL.view}</a>
</div>
${uncertain}
<p class="ht-disc">${AL.disc}</p>
<script>(function(){try{var s=localStorage.getItem('atmSub')||'';var slug=${JSON.stringify(a.slug)};if(s){var c=document.getElementById('htCta');if(c)c.href='/go/hot-tour/'+encodeURIComponent(slug)+'?s='+encodeURIComponent(s);}new Image().src='/px/v?slug='+encodeURIComponent(slug)+(s?'&s='+encodeURIComponent(s):'');}catch(e){}})();</script>
</div></body></html>`;
  }

  // Spread gallery images evenly across the gaps between rendered sections (never before the first section).
  // Hero (.ht-hero) stays full-size/unchanged; these render at 75% width (.ht-inline).
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
    while (gi < gallery.length) { out.push(this.inlineImg(gallery[gi])); gi++; }
    return out.join('\n');
  }
  private inlineImg(g: { url: string; alt?: string }): string {
    return `<img class="ht-inline" src="${this.esc(g.url)}" alt="${this.esc(g.alt || '')}" loading="lazy">`;
  }
}
