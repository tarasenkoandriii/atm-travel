import { Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

type Net = 'telegram' | 'whatsapp' | 'viber' | 'youtube' | 'tiktok' | 'instagram' | 'facebook';

/**
 * Publishes a generated reel package (a CineRender set of per-format video URLs) to social networks.
 * Telegram is wired end-to-end (Bot API sendVideo/deleteMessage). The rest return a clear "todo"
 * status — each needs its own OAuth/token flow and can be added behind the same dispatch without
 * touching the UI (publish.html) or this controller's shape.
 */
@Controller('api/publish')
export class PublishController {
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  /** Resolve the best video URL for a package id (prefer 9:16, else the first item). */
  private async video(pkg: string): Promise<{ url: string; title: string } | null> {
    if (!pkg) return null;
    const row = await this.prisma.cineRender.findUnique({ where: { id: pkg } });
    if (!row) return null;
    const items = ((row.items as any[]) || []).filter((i) => i && i.url);
    const pick = items.find((i) => i.format === '9:16') || items[0];
    return pick ? { url: pick.url, title: (row as any).title || 'ATM-travel' } : null;
  }

  @Post()
  async publish(@Body() body: { pkg?: string; network?: Net; target?: string; caption?: string }) {
    const network = body?.network as Net;
    const vid = await this.video(body?.pkg || '');
    if (!vid) return { ok: false, status: 'error', message: 'пакет не найден или пуст' };
    const caption = (body?.caption || vid.title || '').slice(0, 900);

    switch (network) {
      case 'telegram':
        return this.telegram(body?.target || '', vid.url, caption);
      case 'whatsapp':
      case 'viber':
      case 'youtube':
      case 'tiktok':
      case 'instagram':
      case 'facebook':
        return { ok: false, status: 'todo', message: `Интеграция «${network}» появится позже (нужен OAuth/токен провайдера)` };
      default:
        return { ok: false, status: 'error', message: 'неизвестная сеть' };
    }
  }

  @Post('remove')
  async remove(@Body() body: { network?: Net; target?: string; postId?: string }) {
    if (body?.network === 'telegram') return this.telegramRemove(body?.target || '', body?.postId || '');
    return { ok: false, status: 'todo', message: `Удаление для «${body?.network || '?'}» пока не реализовано` };
  }

  // ── Telegram Bot API ──────────────────────────────────────────────────────
  private async telegram(chatId: string, videoUrl: string, caption: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return { ok: false, status: 'error', message: 'TELEGRAM_BOT_TOKEN не настроен на сервере' };
    if (!chatId) return { ok: false, status: 'error', message: 'укажите chat_id или @канал в «Настроить»' };
    try {
      const u = `https://api.telegram.org/bot${token}/sendVideo?chat_id=${encodeURIComponent(chatId)}` +
        `&video=${encodeURIComponent(videoUrl)}&caption=${encodeURIComponent(caption)}`;
      const r = await fetch(u);
      const j: any = await r.json();
      if (j?.ok) return { ok: true, status: 'ok', message: 'опубликовано', postId: String(j.result?.message_id ?? ''), raw: j.result };
      return { ok: false, status: 'error', message: j?.description || `HTTP ${r.status}`, raw: j };
    } catch (e: any) {
      return { ok: false, status: 'error', message: String(e?.message || e) };
    }
  }

  private async telegramRemove(chatId: string, messageId: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || !chatId || !messageId) return { ok: false, status: 'error', message: 'нет токена / chat_id / message_id' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/deleteMessage?chat_id=${encodeURIComponent(chatId)}&message_id=${encodeURIComponent(messageId)}`);
      const j: any = await r.json();
      return j?.ok ? { ok: true, status: 'ok', message: 'удалено' } : { ok: false, status: 'error', message: j?.description || 'ошибка удаления' };
    } catch (e: any) {
      return { ok: false, status: 'error', message: String(e?.message || e) };
    }
  }
}
