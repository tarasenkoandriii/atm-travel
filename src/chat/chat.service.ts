import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { EmbeddingService } from '../embeddings/embeddings.service';

const GOALS = ['GREETING', 'DISCOVERY', 'RECOMMEND', 'PERSUADE', 'CLOSE_BUY', 'CLOSE_REMINDER', 'CLOSE_LEAD', 'CAPTURED'];

// ── Knowledge base: FAQ + how-to for the site, AI search and subscriptions ──
const KB = `
О ПРОЕКТЕ
- ATM-travel (ОРБИТА) — сайт с живыми камерами со всего мира и подборкой «горящих туров».
- Живые камеры: на главной крутящийся глобус, авто-перебор камер, звук, избранное.

ГОРЯЩИЕ ТУРЫ
- Раздел «🔥 Горящие туры» в шапке ведёт на /hot-tours — по странам, с ценами, скидками, датами.
- Ссылки на бронирование — партнёрские; цена и наличие актуальны на момент публикации.

AI-ПОИСК
- Кнопка «🔎 AI-поиск» в шапке: запрос на естественном языке, напр. «Турция до 30 000 грн, 5★, октябрь».
- Понимает страну, город, бюджет (в т.ч. «30к»), звёздность, месяц, число ночей.

ПОДПИСКИ
- Под результатами — «Сохранить поиск и подписаться»: уведомления о новых и подешевевших турах.
- Каналы: Telegram, Email, WhatsApp. Частота: «Мгновенно», «Раз в день», «Лучшее за неделю».
- Дебаунс: одна связка не чаще раза в сутки; подешевевшие помечаются «🔻 подешевел».

TELEGRAM
- Канал «Telegram» → кнопка «Подключить Telegram» → Start в боте; chat_id привяжется автоматически.

УПРАВЛЕНИЕ
- «Мои подписки» рядом с поиском; ссылка «Управление подписками» (/manage?token=…) в каждом письме: пауза/возобновление/отписка без пароля.

ПРИВАТНОСТЬ
- Контакты — только с явным согласием, для связи по подбору тура; отозвать можно в любой момент.
`.trim();

const SYSTEM_PROMPT = `
Ты — дружелюбный travel-консультант ОРБИТА (сайт ATM-travel). Язык — как у пользователя (RU/UA). Коротко, по делу, не больше одного уточняющего вопроса за реплику.

ЦЕЛИ по приоритету (ЭТИЧНО — без тёмных паттернов, без ложного дефицита, «нет» уважается):
1) Подобрать конкретный тур инструментом search_tours и мягко подтолкнуть к переходу по ссылке брони.
2) Если «нравится, но позже» — предложить напоминание (schedule_reminder) на удобную дату.
3) Если не готов — собрать критерии и контакты (save_lead) ТОЛЬКО с явным согласием, проговаривая цель.

ИНСТРУМЕНТЫ:
- search_tours(query, maxPriceUAH?, minStars?) — ВСЕГДА для подбора; не выдумывай цены/наличие, опирайся только на результат.
- save_lead(direction, budget, when, contacts[], consent) — валидно только при consent=true и МИНИМУМ ОДНОМ контакте. Второй контакт приветствуется (надёжнее связаться), но необязателен — не настаивай, если человек не хочет его давать.
- schedule_reminder(tourId, remindAt, channel, target) — напоминание о туре.
- create_booking_intent(tourId, contact) — передать горячего клиента в продажи.
- set_goal_state(state) — обнови этап воронки (${GOALS.join('|')}).

На вопросы «как пользоваться сайтом/поиском/подписками/Telegram» отвечай из БАЗЫ ЗНАНИЙ. Партнёрские ссылки и изменчивость цен упоминай, если уместно.
`.trim();

const TOOLS: any[] = [
  { type: 'function', function: { name: 'search_tours', description: 'Гибридный поиск актуальных туров под критерии пользователя.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Свободный запрос: направление, месяц, тип отдыха' }, maxPriceUAH: { type: 'number', description: 'Максимальная цена в гривнах' }, minStars: { type: 'number', description: 'Минимальная звёздность отеля' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'save_lead', description: 'Сохранить лид: критерии + контакты. Только при consent=true и минимум 1 контакте (второй контакт необязателен, но приветствуется).', parameters: { type: 'object', properties: { direction: { type: 'string' }, budget: { type: 'number' }, when: { type: 'string' }, contacts: { type: 'array', items: { type: 'string' } }, consent: { type: 'boolean' } }, required: ['contacts', 'consent'] } } },
  { type: 'function', function: { name: 'schedule_reminder', description: 'Назначить напоминание о туре на дату.', parameters: { type: 'object', properties: { tourId: { type: 'string' }, remindAt: { type: 'string', description: 'ISO-дата/время' }, channel: { type: 'string', enum: ['telegram', 'email'] }, target: { type: 'string', description: 'chat_id или email' }, message: { type: 'string' } }, required: ['remindAt', 'channel', 'target'] } } },
  { type: 'function', function: { name: 'create_booking_intent', description: 'Передать горячего клиента в продажи (черновик брони).', parameters: { type: 'object', properties: { tourId: { type: 'string' }, contact: { type: 'string' }, note: { type: 'string' } }, required: ['contact'] } } },
  { type: 'function', function: { name: 'set_goal_state', description: 'Обновить этап воронки диалога.', parameters: { type: 'object', properties: { state: { type: 'string', enum: GOALS } }, required: ['state'] } } },
];

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly embed: EmbeddingService,
  ) {}

  private get baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || 'https://atm-travel.org').replace(/\/$/, ''); }

  // Multilingual: force the assistant to answer in the site-selected language (cookie `locale`).
  private langDirective(lang?: string): string {
    const names: Record<string, string> = {
      ru: 'русском', uk: 'украинском (українською мовою)', en: 'English', pl: 'polskim (po polsku)',
      fr: 'français', de: 'Deutsch', ja: '日本語 (Japanese)', it: 'italiano', pt: 'português', es: 'español',
    };
    const l = (lang || 'ru').toLowerCase();
    const name = names[l] || names.en;
    return `\n\nЯЗЫК ОТВЕТА / RESPONSE LANGUAGE: отвечай ТОЛЬКО на ${name}. Always respond ONLY in this language, regardless of the language of the query or of the tour data.`;
  }
  private unavailableMsg(lang?: string): string {
    const l = (lang || 'ru').toLowerCase();
    if (l === 'uk') return 'Асистент тимчасово недоступний, але ось що знайшлося за запитом. Можна зберегти пошук і підписатися на сповіщення.';
    if (l === 'ru') return 'Ассистент временно недоступен, но вот что нашлось под запрос. Можно сохранить поиск и подписаться на уведомления.';
    return 'The assistant is temporarily unavailable, but here is what matched your query. You can save the search and subscribe to alerts.';
  }

  // ── session + history ──
  async session(sub: string) {
    return this.prisma.chatSession.upsert({ where: { sub }, create: { sub }, update: {} });
  }
  async history(sub: string): Promise<{ goalState: string; messages: { role: string; content: string }[] }> {
    const sess = await this.prisma.chatSession.findUnique({ where: { sub }, include: { messages: { orderBy: { ts: 'asc' }, take: 50 } } }).catch(() => null);
    if (!sess) return { goalState: 'GREETING', messages: [] };
    return { goalState: sess.goalState, messages: sess.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })) };
  }
  async messageCountSince(sub: string, ms: number): Promise<number> {
    return this.prisma.chatMessage.count({ where: { session: { sub }, role: 'user', ts: { gt: new Date(Date.now() - ms) } } }).catch(() => 0);
  }
  private async setGoal(sessionId: string, state: string) {
    if (!GOALS.includes(state)) return;
    await this.prisma.chatSession.update({ where: { id: sessionId }, data: { goalState: state } }).catch(() => {});
  }

  // ── tour search: hybrid (pgvector) with keyword fallback ──
  private async searchTours(query: string, filters: { maxPriceUAH?: number | null; minStars?: number | null } = {}): Promise<any[]> {
    let tours = await this.embed.searchTours(query, filters, 5).catch(() => [] as any[]);
    if (!tours.length) {
      try { const r = await this.search.search(query); tours = r.tours.slice(0, 5).map((t: any) => ({ ...t, link: `/go/tour/${t.id}?u=site&c=chat` })); } catch {}
    }
    return tours;
  }

  private async grok(messages: any[], useTools: boolean): Promise<any> {
    const key = this.config.get<string>('XAI_API_KEY');
    const body: any = { model: 'grok-4.3', messages };
    if (useTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`grok ${r.status}`);
    return r.json();
  }

  // ── main turn: persist history, tool-calling loop, goal_state ──
  async reply(rawMessages: { role: string; content: string }[], sub: string, lang?: string): Promise<{ reply: string; tours: any[]; goalState: string }> {
    const sess = await this.session(sub);
    const incoming = (rawMessages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    const lastUser = [...incoming].reverse().find((m) => m.role === 'user')?.content?.trim() || '';
    if (lastUser) await this.prisma.chatMessage.create({ data: { sessionId: sess.id, role: 'user', content: lastUser.slice(0, 4000) } }).catch(() => {});

    const key = this.config.get<string>('XAI_API_KEY');
    if (!key) {
      const tours = await this.searchTours(lastUser);
      const reply = this.unavailableMsg(lang);
      await this.prisma.chatMessage.create({ data: { sessionId: sess.id, role: 'assistant', content: reply } }).catch(() => {});
      return { reply, tours, goalState: sess.goalState };
    }

    const past = await this.prisma.chatMessage.findMany({ where: { sessionId: sess.id, role: { in: ['user', 'assistant'] } }, orderBy: { ts: 'asc' }, take: 24 }).catch(() => [] as any[]);
    const system = `${SYSTEM_PROMPT}\n\n=== БАЗА ЗНАНИЙ ===\n${KB}\n\nТекущий этап воронки: ${sess.goalState}.${this.langDirective(lang)}`;
    const msgs: any[] = [{ role: 'system', content: system }, ...past.slice(-12).map((m) => ({ role: m.role, content: m.content }))];

    const collected: any[] = [];
    let finalText = '';
    try {
      for (let i = 0; i < 3; i++) {
        const data = await this.grok(msgs, true);
        const m = data?.choices?.[0]?.message || {};
        if (m.tool_calls && m.tool_calls.length) {
          msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
          for (const tc of m.tool_calls) {
            let args: any = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            const result = await this.execTool(tc.function?.name, args, sess, collected, lang);
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          }
          continue;
        }
        finalText = (m.content || '').trim();
        break;
      }
    } catch (e: any) {
      this.logger.warn(`chat reply failed: ${e?.message || e}`);
      if (!collected.length) { const t = await this.searchTours(lastUser); collected.push(...t); }
      finalText = finalText || 'Небольшая заминка на нашей стороне. Вот подходящие варианты ниже — или уточните критерии.';
    }
    if (!finalText) finalText = collected.length ? 'Вот что подобрал под ваш запрос:' : 'Уточните направление и бюджет — подберу варианты.';
    await this.prisma.chatMessage.create({ data: { sessionId: sess.id, role: 'assistant', content: finalText.slice(0, 4000) } }).catch(() => {});
    const fresh = await this.prisma.chatSession.findUnique({ where: { id: sess.id } }).catch(() => sess);
    return { reply: finalText, tours: this.dedupe(collected), goalState: fresh?.goalState || sess.goalState };
  }

  private dedupe(tours: any[]): any[] {
    const seen = new Set<string>(); const out: any[] = [];
    for (const t of tours) { if (t && t.id && !seen.has(t.id)) { seen.add(t.id); out.push(t); } }
    return out.slice(0, 6);
  }

  // ── tool dispatch ──
  private async execTool(name: string, args: any, sess: any, collected: any[], lang?: string): Promise<any> {
    try {
      if (name === 'search_tours') {
        const tours = await this.searchTours(String(args.query || ''), { maxPriceUAH: args.maxPriceUAH ?? null, minStars: args.minStars ?? null });
        collected.push(...tours);
        await this.setGoal(sess.id, 'RECOMMEND');
        return { tours: tours.map((t) => ({ id: t.id, hotel: t.hotel, city: t.city, country: t.country, stars: t.stars, priceUAH: t.priceUAH, discountPct: t.discountPct, nights: t.nights, departureDate: t.departureDate })) };
      }
      if (name === 'save_lead') {
        const res = await this.persistLead({ sub: sess.sub, direction: args.direction, budget: args.budget, when: args.when, contacts: Array.isArray(args.contacts) ? args.contacts : String(args.contacts || '').split(/[,\s]+/), consent: !!args.consent });
        if (res.ok) await this.setGoal(sess.id, 'CAPTURED');
        return res;
      }
      if (name === 'schedule_reminder') {
        const when = new Date(args.remindAt);
        if (isNaN(when.getTime())) return { ok: false, message: 'некорректная дата' };
        if (!args.target) return { ok: false, message: 'нужен контакт (chat_id/email)' };
        await this.prisma.reminder.create({ data: { sub: sess.sub, tourId: args.tourId || null, remindAt: when, channel: args.channel === 'email' ? 'email' : 'telegram', target: String(args.target).slice(0, 200), message: (args.message || '').slice(0, 500) || null, lang: lang || null } });
        await this.setGoal(sess.id, 'CLOSE_REMINDER');
        return { ok: true };
      }
      if (name === 'create_booking_intent') {
        if (!args.contact) return { ok: false, message: 'нужен контакт' };
        const row = await this.prisma.bookingIntent.create({ data: { sub: sess.sub, tourId: args.tourId || null, contact: String(args.contact).slice(0, 200), note: (args.note || '').slice(0, 500) || null } });
        await this.notifyAdmin({ direction: args.tourId ? 'тур ' + args.tourId : 'бронь', budget: null, whenText: null, contacts: row.contact });
        await this.setGoal(sess.id, 'CAPTURED');
        return { ok: true };
      }
      if (name === 'set_goal_state') { await this.setGoal(sess.id, String(args.state || '')); return { ok: true }; }
    } catch (e: any) { this.logger.warn(`tool ${name} failed: ${e?.message || e}`); return { ok: false, message: 'ошибка инструмента' }; }
    return { ok: false, message: 'неизвестный инструмент' };
  }

  // ── lead capture (form + tool) ──
  async saveLead(input: { sub?: string; direction?: string; budget?: string | number; when?: string; contacts?: string[]; note?: string; consent?: boolean; hp?: string }) {
    if (input.hp) return { ok: false, message: 'spam' };
    return this.persistLead(input);
  }
  private async persistLead(input: { sub?: string; direction?: string; budget?: string | number; when?: string; contacts?: string[]; note?: string; consent?: boolean }) {
    if (!input.consent) return { ok: false, message: 'Нужно согласие на обработку данных.' };
    const contacts = (input.contacts || []).map((c) => String(c || '').trim()).filter(Boolean);
    const minContacts = Math.max(1, Number(this.config.get<number>('LEAD_MIN_CONTACTS') ?? 1));
    if (contacts.length < minContacts) {
      return { ok: false, message: minContacts <= 1 ? 'Оставьте хотя бы один контакт (телефон, email или Telegram).' : `Оставьте минимум ${minContacts} контакта (напр. телефон и Telegram/email) — так надёжнее связаться.` };
    }
    const budget = input.budget != null && String(input.budget).trim() !== '' ? (Math.round(Number(String(input.budget).replace(/[^\d]/g, ''))) || null) : null;
    const row = await this.prisma.chatLead.create({
      data: { sub: input.sub || null, direction: (input.direction || '').slice(0, 200) || null, budget, whenText: (input.when || '').slice(0, 200) || null, contacts: contacts.join(', ').slice(0, 500), note: (input.note || '').slice(0, 500) || null, consent: true },
    });
    this.notifyAdmin(row).catch(() => {});
    return { ok: true, id: row.id };
  }

  // Admin-configurable notification channel: DB override (set via /hot-admin) takes precedence over env vars,
  // so the channel can be changed without a redeploy.
  // telegramChatId may hold SEVERAL chat_ids separated by commas (see BlogService.notifyNewDraft,
  // which reads the same AdminSettings row) — parsed into an array so every configured admin gets
  // their own copy of the message instead of sending one malformed "123,456"-style chat_id.
  private async adminChannel(): Promise<{ chats: string[]; email?: string }> {
    const row = await this.prisma.adminSettings.findUnique({ where: { id: 'singleton' } }).catch(() => null);
    const raw = (row?.telegramChatId || '').trim() || this.config.get<string>('ADMIN_TELEGRAM_CHAT_ID') || '';
    return {
      chats: raw.split(',').map((s) => s.trim()).filter(Boolean),
      email: (row?.adminEmail || '').trim() || this.config.get<string>('ADMIN_EMAIL') || undefined,
    };
  }

  async getAdminSettings(): Promise<{ telegramChatId: string; adminEmail: string; usingEnvFallback: { chat: boolean; email: boolean } }> {
    const row = await this.prisma.adminSettings.findUnique({ where: { id: 'singleton' } }).catch(() => null);
    return {
      telegramChatId: row?.telegramChatId || '',
      adminEmail: row?.adminEmail || '',
      usingEnvFallback: { chat: !row?.telegramChatId, email: !row?.adminEmail },
    };
  }

  async saveAdminSettings(patch: { telegramChatId?: string; adminEmail?: string }): Promise<boolean> {
    await this.prisma.adminSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', telegramChatId: (patch.telegramChatId || '').trim() || null, adminEmail: (patch.adminEmail || '').trim() || null },
      update: { telegramChatId: (patch.telegramChatId || '').trim() || null, adminEmail: (patch.adminEmail || '').trim() || null },
    });
    return true;
  }

  // Leads list for the admin dashboard — this is where chat contacts + the client's request end up (ChatLead table).
  async leads(limit = 200): Promise<any[]> {
    return this.prisma.chatLead.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 500) });
  }

  private async notifyAdmin(lead: any) {
    const { chats, email } = await this.adminChannel();
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const text = `🆕 Лид (чат): ${lead.direction || 'направление?'} · бюджет ${lead.budget || '?'} · когда: ${lead.whenText || '?'}\nКонтакты: ${lead.contacts}\n${this.baseUrl}/hot-admin`;
    if (token && chats.length) await Promise.all(chats.map((chat) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) }).catch(() => {}),
    ));
    const key = this.config.get<string>('RESEND_API_KEY'); const from = this.config.get<string>('MAIL_FROM');
    if (key && from && email) await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: email, subject: 'Новый лид из чата ATM-travel', text }) }).catch(() => {});
  }

  // ── reminders dispatch (cron/pg_cron) ──
  async dispatchReminders(max = 30): Promise<{ due: number; sent: number }> {
    this.embed.watchdog().catch(() => {}); // heartbeat: this endpoint runs frequently via pg_cron
    const due = await this.prisma.reminder.findMany({ where: { status: 'scheduled', remindAt: { lte: new Date() } }, orderBy: { remindAt: 'asc' }, take: max }).catch(() => [] as any[]);
    let sent = 0;
    for (const r of due) {
      // Cancel if the liked tour is gone/inactive — offer an alternative instead (§10).
      if (r.tourId) {
        const t = await this.prisma.hotTour.findUnique({ where: { id: r.tourId }, select: { active: true } }).catch(() => null);
        if (t && !t.active) {
          await this.sendReminder({ ...r, message: this.rt(r.lang).gone + `${this.baseUrl}/hot-tours` });
          await this.prisma.reminder.update({ where: { id: r.id }, data: { status: 'canceled', attempts: { increment: 1 } } }).catch(() => {});
          continue;
        }
      }
      const ok = await this.sendReminder(r);
      await this.prisma.reminder.update({ where: { id: r.id }, data: { status: ok ? 'sent' : (r.attempts >= 3 ? 'failed' : 'scheduled'), attempts: { increment: 1 } } }).catch(() => {});
      if (ok) sent++;
    }
    return { due: due.length, sent };
  }
  // ── Privacy (§11): revoke consent / erase this visitor's data (lead + dialog + reminders/booking) ──
  async forget(sub: string): Promise<{ ok: boolean; deleted: number }> {
    if (!sub) return { ok: false, deleted: 0 };
    let deleted = 0;
    const l = await this.prisma.chatLead.deleteMany({ where: { sub } }).catch(() => ({ count: 0 })); deleted += l.count;
    const r = await this.prisma.reminder.deleteMany({ where: { sub } }).catch(() => ({ count: 0 })); deleted += r.count;
    const b = await this.prisma.bookingIntent.deleteMany({ where: { sub } }).catch(() => ({ count: 0 })); deleted += b.count;
    await this.prisma.chatSession.deleteMany({ where: { sub } }).catch(() => {}); // cascades ChatMessage
    return { ok: true, deleted };
  }

  // Standalone reminder creation (§9) — same as the schedule_reminder tool, callable directly.
  async scheduleReminder(input: { sub?: string; tourId?: string; remindAt?: string; channel?: string; target?: string; message?: string; lang?: string }): Promise<{ ok: boolean; id?: string; message?: string }> {
    const when = new Date(input.remindAt || Date.now() + 7 * 864e5);
    if (isNaN(+when)) return { ok: false, message: 'некорректная дата' };
    if (!input.target) return { ok: false, message: 'нужен адрес доставки (chat_id/email)' };
    const rem = await this.prisma.reminder.create({ data: { sub: input.sub || null, tourId: input.tourId || null, remindAt: when, channel: input.channel === 'email' ? 'email' : 'telegram', target: String(input.target).slice(0, 200), message: (input.message || '').slice(0, 400) || null, lang: input.lang || null } });
    return { ok: true, id: rem.id };
  }

  // Reminder text localized by the stored language.
  private rt(lang?: string): { remind: string; gone: string; subject: string } {
    const D: Record<string, any> = {
      ru: { remind: 'Напоминание о туре, который вам понравился на ATM-travel: ', gone: 'К сожалению, тур из напоминания уже недоступен. Свежие горящие туры: ', subject: 'Напоминание о туре — ATM-travel' },
      uk: { remind: 'Нагадування про тур, який вам сподобався на ATM-travel: ', gone: 'На жаль, тур із нагадування вже недоступний. Свіжі гарячі тури: ', subject: 'Нагадування про тур — ATM-travel' },
      en: { remind: 'A reminder about the tour you liked on ATM-travel: ', gone: 'Unfortunately, the tour from your reminder is no longer available. Fresh hot tours: ', subject: 'Tour reminder — ATM-travel' },
      pl: { remind: 'Przypomnienie o wycieczce, która Ci się spodobała na ATM-travel: ', gone: 'Niestety wycieczka z przypomnienia jest już niedostępna. Świeże gorące oferty: ', subject: 'Przypomnienie o wycieczce — ATM-travel' },
      fr: { remind: 'Un rappel du séjour qui vous a plu sur ATM-travel : ', gone: 'Malheureusement, le séjour de votre rappel n’est plus disponible. Séjours récents : ', subject: 'Rappel de séjour — ATM-travel' },
      de: { remind: 'Eine Erinnerung an die Reise, die dir auf ATM-travel gefallen hat: ', gone: 'Leider ist die Reise aus deiner Erinnerung nicht mehr verfügbar. Aktuelle Angebote: ', subject: 'Reise-Erinnerung — ATM-travel' },
      ja: { remind: 'ATM-travel で気に入ったツアーのリマインダー: ', gone: '申し訳ありません。リマインダーのツアーは現在ご利用いただけません。最新のお得なツアー: ', subject: 'ツアーのリマインダー — ATM-travel' },
      it: { remind: 'Un promemoria del viaggio che ti è piaciuto su ATM-travel: ', gone: 'Purtroppo il viaggio del promemoria non è più disponibile. Offerte recenti: ', subject: 'Promemoria viaggio — ATM-travel' },
      pt: { remind: 'Um lembrete da viagem que gostou no ATM-travel: ', gone: 'Infelizmente a viagem do lembrete já não está disponível. Ofertas recentes: ', subject: 'Lembrete de viagem — ATM-travel' },
      es: { remind: 'Un recordatorio del viaje que te gustó en ATM-travel: ', gone: 'Lamentablemente, el viaje de tu recordatorio ya no está disponible. Ofertas recientes: ', subject: 'Recordatorio de viaje — ATM-travel' },
    };
    return D[(lang || 'ru').toLowerCase()] || D.en;
  }

  // ── Chat funnel by goal_state (§I.12) for the admin dashboard ──
  async chatFunnel(): Promise<any> {
    const [byState, sessions, leads, reminders, bookings] = await Promise.all([
      this.prisma.chatSession.groupBy({ by: ['goalState'], _count: { _all: true } }).catch(() => [] as any[]),
      this.prisma.chatSession.count().catch(() => 0),
      this.prisma.chatLead.count().catch(() => 0),
      this.prisma.reminder.count().catch(() => 0),
      this.prisma.bookingIntent.count().catch(() => 0),
    ]);
    const counts = new Map<string, number>((byState as any[]).map((r: any) => [r.goalState, r._count._all] as [string, number]));
    const captured = counts.get('CAPTURED') || 0;
    return {
      sessions, leads, reminders, bookings, captured,
      capturedRate: sessions ? Math.round((captured / sessions) * 1000) / 10 : 0,
      states: GOALS.map((s) => ({ state: s, count: counts.get(s) || 0 })),
    };
  }

  private async sendReminder(r: any): Promise<boolean> {
    const R = this.rt(r.lang);
    const text = r.message || `${R.remind}${this.baseUrl}${r.tourId ? '/go/tour/' + r.tourId + '?u=' + r.channel + '&c=reminder' : '/hot-tours'}`;
    try {
      if (r.channel === 'telegram') {
        const token = this.config.get<string>('TELEGRAM_BOT_TOKEN'); if (!token) return false;
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: r.target, text, disable_web_page_preview: true }) });
        const j: any = await resp.json().catch(() => null); return !!j?.ok;
      }
      const key = this.config.get<string>('RESEND_API_KEY'); const from = this.config.get<string>('MAIL_FROM');
      if (!key || !from) return false;
      const resp = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: r.target, subject: R.subject, text }) });
      return resp.ok;
    } catch { return false; }
  }
}
