import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { countryCodeOf } from '../hottours/geo-names';

export interface SearchFilter {
  country?: string | null;
  cc?: string | null;
  city?: string | null;
  maxPriceUAH?: number | null;
  minStars?: number | null;
  month?: number | null;     // 1-12
  nightsMax?: number | null;
  boardType?: string | null;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private get baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || 'https://atm-travel.org').replace(/\/$/, ''); }
  cronAllowed(auth?: string, xsec?: string): boolean {
    const s = this.config.get<string>('CRON_SECRET');
    return !!s && (auth === `Bearer ${s}` || xsec === s);
  }

  // ── Parse a free-text query into a structured filter (Grok, with a heuristic fallback) ──
  async parse(q: string): Promise<SearchFilter> {
    const base = this.heuristic(q);
    const key = this.config.get<string>('XAI_API_KEY');
    if (!key || !q?.trim()) return base;
    const sys =
      'Разбери запрос туриста в JSON-фильтр для поиска горящих туров. Валюта — украинская гривна (грн). ' +
      'Если бюджет указан в тысячах («30к», «25 тыс», «до 40к») — переведи в гривны (30000, 25000, 40000). ' +
      'Верни СТРОГО валидный JSON без markdown: {"country":string|null,"cc":string|null,"city":string|null,' +
      '"maxPriceUAH":number|null,"minStars":number|null,"month":number|null,"nightsMax":number|null,"boardType":string|null}. ' +
      'cc — ISO alpha-2 в нижнем регистре (Турция→tr). month — номер месяца 1-12. Ничего не выдумывай: чего нет в запросе — null.';
    try {
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: sys }, { role: 'user', content: q }] }),
      });
      if (!r.ok) return base;
      const data: any = await r.json();
      const j = this.parseJson(data?.choices?.[0]?.message?.content || '') || {};
      return {
        country: j.country || base.country || null,
        cc: (j.cc || base.cc || null) ? String(j.cc || base.cc).toLowerCase() : null,
        city: j.city || base.city || null,
        maxPriceUAH: Number(j.maxPriceUAH) > 0 ? Math.round(Number(j.maxPriceUAH)) : (base.maxPriceUAH || null),
        minStars: Number(j.minStars) > 0 ? Math.round(Number(j.minStars)) : (base.minStars || null),
        month: Number(j.month) >= 1 && Number(j.month) <= 12 ? Math.round(Number(j.month)) : (base.month || null),
        nightsMax: Number(j.nightsMax) > 0 ? Math.round(Number(j.nightsMax)) : null,
        boardType: j.boardType || null,
      };
    } catch { return base; }
  }

  private heuristic(q: string): SearchFilter {
    const s = (q || '').toLowerCase();
    let maxPriceUAH: number | null = null;
    const m = s.match(/(\d[\d\s]*)\s*(к|k|тыс|тис|000)?/);
    if (m) { let n = Number(m[1].replace(/\s/g, '')); if (m[2] && /к|k|тыс|тис/.test(m[2])) n *= 1000; if (n >= 3000 && n <= 1_000_000) maxPriceUAH = n; }
    let cc: string | null = null, country: string | null = null;
    for (const w of s.split(/[^\p{L}]+/u)) { const c = countryCodeOf(w); if (c) { cc = c.toLowerCase(); country = w; break; } }
    const stars = s.match(/([2-5])\s*(★|звёзд|звезд|зірок|star)/); const minStars = stars ? Number(stars[1]) : null;
    return { country, cc, city: null, maxPriceUAH, minStars, month: null, nightsMax: null, boardType: null };
  }

  private parseJson(t: string): any {
    if (!t) return null; let s = String(t).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(s); } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    return null;
  }

  // ── Query active tours by a filter ──
  private whereFor(f: SearchFilter, extra: any = {}): any {
    const where: any = { active: true, ...extra };
    if (f.cc) where.countryCode = f.cc.toUpperCase();
    if (f.maxPriceUAH) where.priceUAH = { lte: f.maxPriceUAH };
    if (f.minStars) where.hotelStars = { gte: f.minStars };
    if (f.city) where.destinationCity = { contains: f.city, mode: 'insensitive' };
    return where;
  }
  private postFilter(rows: any[], f: SearchFilter): any[] {
    let list = rows;
    if (f.month) list = list.filter((t) => new Date(t.departureDate).getMonth() + 1 === f.month);
    if (f.nightsMax) list = list.filter((t) => t.nights <= (f.nightsMax as number));
    if (f.boardType) list = list.filter((t) => (t.boardType || '').toLowerCase().includes(String(f.boardType).toLowerCase()));
    return list;
  }
  private mapTour(t: any) {
    return {
      id: t.id, city: t.destinationCity, country: t.destinationCountry, cc: (t.countryCode || '').toLowerCase(),
      hotel: t.hotelName, stars: t.hotelStars, priceUAH: t.priceUAH, oldPriceUAH: t.oldPriceUAH, prevPriceUAH: t.prevPriceUAH,
      discountPct: t.discountPct, departureDate: t.departureDate, nights: t.nights, link: t.affiliateDeepLink,
    };
  }

  async search(q: string, sub?: string): Promise<{ filter: SearchFilter; tours: any[] }> {
    const filter = await this.parse(q);
    const rows = await this.prisma.hotTour.findMany({ where: this.whereFor(filter), orderBy: [{ discountPct: 'desc' }, { priceUAH: 'asc' }], take: 40 });
    const tours = this.postFilter(rows, filter).slice(0, 24).map((t) => { const m = this.mapTour(t); m.link = this.trackUrl(t.id, 'site', 'site-search', sub); return m; });
    return { filter, tours };
  }

  // ── Saved searches / subscriptions ──
  async save(input: { query: string; filter?: SearchFilter; channel: string; address: string; sub?: string; frequency?: string; lang?: string }) {
    const channel = ['email', 'telegram', 'whatsapp'].includes(input.channel) ? input.channel : '';
    if (!channel) return { ok: false, message: 'канал должен быть email/telegram/whatsapp' };
    const frequency = ['daily', 'weekly'].includes(input.frequency || '') ? input.frequency : 'instant';
    let address = (input.address || '').trim();
    if (channel === 'telegram' && !address) {
      const link = input.sub ? await this.prisma.telegramLink.findUnique({ where: { sub: input.sub } }).catch(() => null) : null;
      if (!link) return { ok: false, message: 'сначала подключите Telegram (кнопка «Подключить Telegram»)' };
      address = link.chatId;
    }
    if (!address) return { ok: false, message: 'укажите адрес доставки' };
    const filter = input.filter || (await this.parse(input.query));
    const row = await this.prisma.savedSearch.create({
      data: { sub: input.sub || null, query: input.query || '', filterJson: filter as any, channel, address, frequency, lang: (input.lang || '').slice(0, 5) || null },
    });
    return { ok: true, id: row.id, token: row.token };
  }

  async list(sub: string) {
    if (!sub) return [];
    const rows = await this.prisma.savedSearch.findMany({ where: { sub, canceledAt: null }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, token: r.token, query: r.query, filter: r.filterJson, channel: r.channel, address: r.address, active: r.active, createdAt: r.createdAt }));
  }

  async remove(token: string) {
    if (!token) return { ok: false };
    // Soft-delete: keep the row for retention history, stop delivery.
    await this.prisma.savedSearch.updateMany({ where: { token, canceledAt: null }, data: { active: false, canceledAt: new Date() } });
    return { ok: true };
  }

  /** Manage-by-token: return the subscription and all others sharing the same subscriber. */
  async manage(token: string) {
    const cur = await this.prisma.savedSearch.findUnique({ where: { token } }).catch(() => null);
    if (!cur) return { ok: false, subscriptions: [] as any[] };
    const all = cur.sub
      ? await this.prisma.savedSearch.findMany({ where: { sub: cur.sub, canceledAt: null }, orderBy: { createdAt: 'desc' } })
      : [cur];
    return {
      ok: true,
      subscriptions: all.map((r) => ({ token: r.token, query: r.query, filter: r.filterJson, channel: r.channel, address: r.address, active: r.active, createdAt: r.createdAt })),
    };
  }

  async toggle(token: string, active: boolean) {
    if (!token) return { ok: false };
    await this.prisma.savedSearch.updateMany({ where: { token }, data: { active } });
    return { ok: true, active };
  }

  // ── Notify subscribers: instant / daily digest / weekly best-of ──
  async notify() { return this.run('instant'); }
  async digest() { return this.run('daily'); }
  async weekly() { return this.run('weekly'); }

  private async run(freq: 'instant' | 'daily' | 'weekly'): Promise<{ checked: number; sent: number }> {
    const subs = await this.prisma.savedSearch.findMany({ where: { active: true, frequency: freq }, take: 500 }).catch(() => [] as any[]);
    const hours = Number(this.config.get<number>('SEARCH_NOTIFY_DEBOUNCE_HOURS') ?? 24);
    const cutoff = new Date(Date.now() - hours * 3600e3);
    let sent = 0;
    for (const s of subs) {
      const f = (s.filterJson as any) || {};
      let list: any[] = [];
      if (freq === 'weekly') {
        // Best current matching offers (top discount, then cheapest) — regardless of "new".
        let rows: any[] = [];
        try { rows = await this.prisma.hotTour.findMany({ where: this.whereFor(f), orderBy: [{ discountPct: 'desc' }, { priceUAH: 'asc' }], take: 16 }); } catch {}
        list = this.postFilter(rows, f).slice(0, 10);
        await this.prisma.savedSearch.update({ where: { id: s.id }, data: { lastCheckedAt: new Date() } }).catch(() => {});
        if (!list.length) continue;
      } else {
        const where = { AND: [this.whereFor(f), { OR: [{ createdAt: { gt: s.lastCheckedAt } }, { priceDropAt: { gt: s.lastCheckedAt } }] }] };
        let rows: any[] = [];
        try { rows = await this.prisma.hotTour.findMany({ where, orderBy: { priceUAH: 'asc' }, take: 24 }); } catch {}
        list = this.postFilter(rows, f);
        await this.prisma.savedSearch.update({ where: { id: s.id }, data: { lastCheckedAt: new Date() } }).catch(() => {});
        if (!list.length) continue;
        const recent = await this.prisma.searchNotification.findMany({ where: { searchId: s.id, sentAt: { gt: cutoff } }, select: { tourId: true } }).catch(() => [] as any[]);
        const seen = new Set(recent.map((r: any) => r.tourId));
        list = list.filter((t) => !seen.has(t.id)).slice(0, freq === 'daily' ? 12 : 6);
        if (!list.length) continue;
      }
      const ok = await this.deliver(s, list);
      if (!ok) continue;
      sent++;
      if (freq !== 'weekly') {
        for (const t of list) {
          await this.prisma.searchNotification.upsert({
            where: { searchId_tourId: { searchId: s.id, tourId: t.id } },
            create: { searchId: s.id, tourId: t.id }, update: { sentAt: new Date() },
          }).catch(() => {});
        }
      }
    }
    return { checked: subs.length, sent };
  }

  /** Tracking redirect (logs the click + campaign → CTR dashboard), then affiliate URL + UTM. */
  private trackUrl(tourId: string, channel: string, campaign: string, sub?: string): string {
    const s = sub ? `&s=${encodeURIComponent(sub)}` : '';
    return `${this.baseUrl}/go/tour/${tourId}?u=${encodeURIComponent(channel)}&c=${encodeURIComponent(campaign)}${s}`;
  }
  private async imagesFor(tourIds: string[]): Promise<Map<string, string>> {
    const arts = await this.prisma.hotTourArticle.findMany({ where: { tourId: { in: tourIds }, imageUrl: { not: null } }, select: { tourId: true, imageUrl: true } }).catch(() => [] as any[]);
    return new Map(arts.map((a: any) => [a.tourId, a.imageUrl]));
  }

  // Notification chrome localized by the subscriber's chosen language (s.lang). en fallback.
  private nt(lang?: string) {
    const D: Record<string, any> = {
      ru: { tW: 'Лучшее за неделю по вашему поиску', tD: 'Дайджест по вашему поиску', tI: 'Новые предложения по вашему поиску', defQ: 'горящие туры', drop: 'подешевел (был', dropEnd: ')', tour: 'тур', nights: 'ноч.', depart: 'вылет', view: 'Смотреть тур →', manage: 'Управление подписками', manageHtml: 'Управлять подписками', allTours: 'Все горящие туры', hook: 'для вас', words: 'туров', from: 'от', footer: 'Вы получили это письмо, потому что подписались на поиск туров на ATM-travel.', tagline: 'живые камеры планеты · горящие туры' },
      uk: { tW: 'Найкраще за тиждень за вашим пошуком', tD: 'Дайджест за вашим пошуком', tI: 'Нові пропозиції за вашим пошуком', defQ: 'гарячі тури', drop: 'подешевшав (був', dropEnd: ')', tour: 'тур', nights: 'ноч.', depart: 'виліт', view: 'Дивитися тур →', manage: 'Керування підписками', manageHtml: 'Керувати підписками', allTours: 'Усі гарячі тури', hook: 'для вас', words: 'турів', from: 'від', footer: 'Ви отримали цей лист, бо підписалися на пошук турів на ATM-travel.', tagline: 'живі камери планети · гарячі тури' },
      en: { tW: 'Best of the week for your search', tD: 'Digest for your search', tI: 'New deals for your search', defQ: 'hot tours', drop: 'price dropped (was', dropEnd: ')', tour: 'tour', nights: 'nights', depart: 'departure', view: 'View tour →', manage: 'Manage subscriptions', manageHtml: 'Manage subscriptions', allTours: 'All hot tours', hook: 'for you', words: 'tours', from: 'from', footer: 'You received this email because you subscribed to tour search on ATM-travel.', tagline: 'live cameras of the planet · hot tours' },
      pl: { tW: 'Najlepsze z tygodnia dla Twojego wyszukiwania', tD: 'Podsumowanie dla Twojego wyszukiwania', tI: 'Nowe oferty dla Twojego wyszukiwania', defQ: 'gorące wycieczki', drop: 'potaniało (było', dropEnd: ')', tour: 'wycieczka', nights: 'nocy', depart: 'wylot', view: 'Zobacz wycieczkę →', manage: 'Zarządzaj subskrypcjami', manageHtml: 'Zarządzaj subskrypcjami', allTours: 'Wszystkie gorące wycieczki', hook: 'dla Ciebie', words: 'wycieczek', from: 'od', footer: 'Otrzymujesz tę wiadomość, bo zapisałeś się na wyszukiwanie wycieczek na ATM-travel.', tagline: 'kamery na żywo z całego świata · gorące wycieczki' },
      fr: { tW: 'Le meilleur de la semaine pour votre recherche', tD: 'Résumé pour votre recherche', tI: 'Nouvelles offres pour votre recherche', defQ: 'séjours de dernière minute', drop: 'a baissé (était', dropEnd: ')', tour: 'séjour', nights: 'nuits', depart: 'départ', view: 'Voir le séjour →', manage: 'Gérer les abonnements', manageHtml: 'Gérer les abonnements', allTours: 'Tous les séjours', hook: 'pour vous', words: 'séjours', from: 'à partir de', footer: 'Vous recevez cet e-mail car vous vous êtes abonné à la recherche de séjours sur ATM-travel.', tagline: 'caméras en direct de la planète · séjours de dernière minute' },
      de: { tW: 'Das Beste der Woche für deine Suche', tD: 'Digest für deine Suche', tI: 'Neue Angebote für deine Suche', defQ: 'Last-Minute-Reisen', drop: 'günstiger (war', dropEnd: ')', tour: 'Reise', nights: 'Nächte', depart: 'Abflug', view: 'Reise ansehen →', manage: 'Abos verwalten', manageHtml: 'Abos verwalten', allTours: 'Alle Angebote', hook: 'für dich', words: 'Reisen', from: 'ab', footer: 'Du erhältst diese E-Mail, weil du die Reisesuche auf ATM-travel abonniert hast.', tagline: 'Live-Kameras der Welt · Last-Minute-Reisen' },
      ja: { tW: 'あなたの検索の今週のベスト', tD: 'あなたの検索のダイジェスト', tI: 'あなたの検索の新着', defQ: 'お得なツアー', drop: '値下げ（元', dropEnd: '）', tour: 'ツアー', nights: '泊', depart: '出発', view: 'ツアーを見る →', manage: '購読を管理', manageHtml: '購読を管理', allTours: 'すべてのお得なツアー', hook: 'あなたに', words: '件のツアー', from: '最安', footer: 'ATM-travel でツアー検索を購読したため、このメールが届いています。', tagline: '世界のライブカメラ · お得なツアー' },
      it: { tW: 'Il meglio della settimana per la tua ricerca', tD: 'Riepilogo per la tua ricerca', tI: 'Nuove offerte per la tua ricerca', defQ: 'offerte last minute', drop: 'prezzo sceso (era', dropEnd: ')', tour: 'viaggio', nights: 'notti', depart: 'partenza', view: 'Vedi il viaggio →', manage: 'Gestisci iscrizioni', manageHtml: 'Gestisci iscrizioni', allTours: 'Tutte le offerte', hook: 'per te', words: 'viaggi', from: 'da', footer: 'Ricevi questa email perché ti sei iscritto alla ricerca viaggi su ATM-travel.', tagline: 'telecamere live del pianeta · offerte last minute' },
      pt: { tW: 'O melhor da semana para a sua pesquisa', tD: 'Resumo para a sua pesquisa', tI: 'Novas ofertas para a sua pesquisa', defQ: 'viagens de última hora', drop: 'baixou de preço (era', dropEnd: ')', tour: 'viagem', nights: 'noites', depart: 'partida', view: 'Ver viagem →', manage: 'Gerir inscrições', manageHtml: 'Gerir inscrições', allTours: 'Todas as ofertas', hook: 'para si', words: 'viagens', from: 'desde', footer: 'Recebe este email porque se inscreveu na pesquisa de viagens no ATM-travel.', tagline: 'câmaras ao vivo do planeta · viagens de última hora' },
      es: { tW: 'Lo mejor de la semana para tu búsqueda', tD: 'Resumen para tu búsqueda', tI: 'Nuevas ofertas para tu búsqueda', defQ: 'viajes de última hora', drop: 'bajó de precio (era', dropEnd: ')', tour: 'viaje', nights: 'noches', depart: 'salida', view: 'Ver viaje →', manage: 'Gestionar suscripciones', manageHtml: 'Gestionar suscripciones', allTours: 'Todas las ofertas', hook: 'para ti', words: 'viajes', from: 'desde', footer: 'Recibes este correo porque te suscribiste a la búsqueda de viajes en ATM-travel.', tagline: 'cámaras en vivo del planeta · viajes de última hora' },
    };
    return D[(lang || 'ru').toLowerCase()] || D.en;
  }

  private async deliver(s: any, tours: any[]): Promise<boolean> {
    const freq = s.frequency || 'instant';
    const T = this.nt(s.lang);
    const q = s.query || T.defQ;
    const title = freq === 'weekly' ? `${T.tW} «${q}»` : freq === 'daily' ? `${T.tD} «${q}»` : `${T.tI} «${q}»`;
    const manageUrl = `${this.baseUrl}/manage?token=${s.token}${s.lang ? `&lang=${s.lang}` : ''}`;
    const buildText = (campaign: string) => {
      const lines = tours.map((t) => {
        const drop = t.prevPriceUAH && t.prevPriceUAH > t.priceUAH ? `🔻 ${T.drop} ${Number(t.prevPriceUAH).toLocaleString('uk-UA')} грн${T.dropEnd} ` : '';
        const url = this.trackUrl(t.id, s.channel, campaign, s.sub);
        return `• ${drop}${t.destinationCity}${t.destinationCountry ? ', ' + t.destinationCountry : ''} — ${t.hotelName || T.tour} ${t.hotelStars || ''}★, ${Number(t.priceUAH).toLocaleString('uk-UA')} грн${t.discountPct ? ` (−${t.discountPct}%)` : ''}, ${T.depart} ${new Date(t.departureDate).toLocaleDateString('uk-UA')}\n  ${url}`;
      });
      return `${title}:\n${lines.join('\n')}\n\n${T.manage}: ${manageUrl}`;
    };
    try {
      if (s.channel === 'telegram') return this.sendTelegram(s.address, buildText(freq));
      if (s.channel === 'whatsapp') return this.sendWhatsApp(s.address, buildText(freq));
      if (s.channel === 'email') {
        const ab = this.subjectVariant(title, tours, T);      // A/B subject line
        const campaign = `${freq}-${ab.variant}`;             // attribute opens/clicks to the variant
        const imgs = await this.imagesFor(tours.map((t) => t.id));
        const ok = await this.sendEmail(s.address, ab.subject, buildText(campaign), this.emailHtml(ab.subject, tours, s.channel, campaign, imgs, manageUrl, s.sub, T));
        if (ok) await this.prisma.emailEvent.create({ data: { campaign, kind: 'send' } }).catch(() => {});
        return ok;
      }
    } catch (e: any) { this.logger.warn(`deliver failed (${s.channel}): ${e?.message || e}`); }
    return false;
  }

  /** A/B subject line: A = descriptive, B = punchy price hook. Variant recorded via the click campaign. */
  private subjectVariant(title: string, tours: any[], T: any): { subject: string; variant: string } {
    if (Math.random() < 0.5) return { subject: title, variant: 'A' };
    const prices = tours.map((t) => Number(t.priceUAH)).filter((n) => n > 0);
    const min = prices.length ? Math.min(...prices) : 0;
    const n = tours.length;
    return { subject: `🔥 ${n} ${T.words} ${T.hook}${min ? ` — ${T.from} ${min.toLocaleString('uk-UA')} грн` : ''}`, variant: 'B' };
  }

  private esc(s: any) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]); }

  private emailHtml(title: string, tours: any[], channel: string, campaign: string, imgs: Map<string, string>, manageUrl: string, sub?: string, T: any = this.nt('ru')): string {
    const logo = this.config.get<string>('MAIL_LOGO_URL') || '';
    const brand = logo
      ? `<img src="${this.esc(logo)}" alt="ATM·travel" height="26" style="display:block">`
      : `<span style="font-size:20px;font-weight:800;color:#0e7c86;letter-spacing:.2px">ATM<span style="color:#0b1a24">·</span>travel</span>`;
    const cards = tours.map((t) => {
      const img = imgs.get(t.id);
      const url = this.trackUrl(t.id, channel, campaign, sub);
      const drop = t.prevPriceUAH && t.prevPriceUAH > t.priceUAH ? `<span style="color:#c0392b">🔻 ${T.drop} ${Number(t.prevPriceUAH).toLocaleString('uk-UA')} грн${T.dropEnd}</span><br>` : '';
      const old = t.oldPriceUAH ? `<span style="color:#8a97a3;text-decoration:line-through;font-size:13px">${Number(t.oldPriceUAH).toLocaleString('uk-UA')} грн</span> ` : '';
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #e6e9ee">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
        ${img ? `<td width="120" valign="top"><a href="${url}"><img src="${this.esc(img)}" width="110" height="74" style="border-radius:8px;object-fit:cover;display:block" alt=""></a></td>` : ''}
        <td valign="top" style="padding-left:${img ? '12px' : '0'}">
          <div style="font-weight:700;font-size:15px;color:#0b1a24">${this.esc(t.hotelName || t.destinationCity)} · ${t.hotelStars || 0}★</div>
          <div style="color:#5c6b7a;font-size:13px;margin:3px 0">${this.esc(t.destinationCity)}, ${this.esc(t.destinationCountry || '')} · ${t.nights || ''} ${T.nights} · ${T.depart} ${new Date(t.departureDate).toLocaleDateString('uk-UA')}</div>
          <div style="margin-top:4px">${drop}${old}<b style="font-size:16px;color:#0e7c86">${Number(t.priceUAH).toLocaleString('uk-UA')} грн</b>${t.discountPct ? ` <span style="color:#c0392b">−${t.discountPct}%</span>` : ''}</div>
          <div style="margin-top:6px"><a href="${url}" style="display:inline-block;background:#0e7c86;color:#fff;text-decoration:none;padding:7px 14px;border-radius:8px;font-size:13px">${T.view}</a></div>
        </td></tr></table></td></tr>`;
    }).join('');
    return `<div style="background:#f4f6f8;padding:20px 0;font-family:system-ui,'Segoe UI',sans-serif">
      <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e9ee">
        <tr><td style="background:#0b131c;padding:16px 20px">${brand}<div style="color:#7d8b99;font-size:12px;margin-top:2px">${T.tagline}</div></td></tr>
        <tr><td style="padding:18px 20px">
          <h2 style="font-size:18px;margin:0 0 12px;color:#0b1a24">${this.esc(title)}</h2>
          <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
        </td></tr>
        <tr><td style="padding:14px 20px;background:#fafbfc;border-top:1px solid #e6e9ee;color:#8a97a3;font-size:12px">
          ${T.footer}<br>
          <a href="${manageUrl}" style="color:#0e7c86">${T.manageHtml}</a> · <a href="${this.baseUrl}/hot-tours" style="color:#0e7c86">${T.allTours}</a>
        </td></tr>
      </table>
      </td></tr></table>
      <img src="${this.baseUrl}/px/o?c=${encodeURIComponent(campaign)}" width="1" height="1" alt="" style="display:none">
    </div>`;
  }

  private async sendTelegram(chatId: string, text: string): Promise<boolean> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN'); if (!token) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const j: any = await r.json().catch(() => null); return !!j?.ok;
  }
  private async sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
    const key = this.config.get<string>('RESEND_API_KEY'); const from = this.config.get<string>('MAIL_FROM');
    if (!key || !from) return false;
    const body: any = { from, to, subject, text };
    if (html) body.html = html;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok;
  }
  private async sendWhatsApp(phone: string, text: string): Promise<boolean> {
    const id = this.config.get<string>('WHATSAPP_PHONE_ID'); const token = this.config.get<string>('WHATSAPP_TOKEN');
    if (!id || !token) return false;
    const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(id)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace(/[^\d]/g, ''), type: 'text', text: { body: text } }),
    });
    return r.ok;
  }
}
