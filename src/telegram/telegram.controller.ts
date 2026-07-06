import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Telegram bot flow: the user opens t.me/<bot>?start=<sub> and presses Start; Telegram delivers
 * "/start <sub>" to this webhook, and we bind their chat_id to the site subscriber id — so the user
 * never has to paste a chat_id by hand. Set the webhook once (see docs) pointing here.
 */
@Controller('api/telegram')
export class TelegramController {
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private botUsername() { return this.config.get<string>('TELEGRAM_BOT_USERNAME') || ''; }

  // Deep link + connection status for a given subscriber.
  @Get('status')
  async status(@Query('sub') sub?: string) {
    const botUsername = this.botUsername();
    const link = await this.prisma.telegramLink.findUnique({ where: { sub: sub || '' } }).catch(() => null);
    const deepLink = botUsername && sub ? `https://t.me/${botUsername}?start=${encodeURIComponent(sub)}` : '';
    return { linked: !!link, botUsername, deepLink };
  }

  // Telegram update webhook. Optionally verified by X-Telegram-Bot-Api-Secret-Token.
  @Post('webhook')
  async webhook(@Body() update: any, @Headers('x-telegram-bot-api-secret-token') secret?: string) {
    const want = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (want && secret !== want) return { ok: false };
    const msg = update?.message || update?.edited_message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || '').trim();
    if (chatId && text.startsWith('/start')) {
      const payload = text.split(/\s+/)[1] || '';
      if (payload) {
        await this.prisma.telegramLink.upsert({
          where: { sub: payload },
          create: { sub: payload, chatId: String(chatId), username: msg?.chat?.username || null },
          update: { chatId: String(chatId), username: msg?.chat?.username || null },
        }).catch(() => {});
        await this.reply(chatId, '✅ Готово! Вы будете получать уведомления о новых и подешевевших турах по вашим сохранённым поискам.');
      } else {
        await this.reply(chatId, 'Привет! Откройте сайт ATM-travel, сохраните поиск и нажмите «Подключить Telegram» — тогда я смогу присылать вам подходящие туры.');
      }
    }
    return { ok: true };
  }

  private async reply(chatId: number | string, text: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN'); if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    }).catch(() => {});
  }
}
