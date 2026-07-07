import { Body, Controller, Get, Headers, Post, Query, Req, HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service';

@Controller('api/chat')
export class ChatController {
  constructor(private readonly svc: ChatService, private readonly config: ConfigService) {}

  // Basic abuse guards for the public chat endpoint (§9 of Part I).
  private originOk(req: Request): boolean {
    const allowed = (this.config.get<string>('ALLOWED_ORIGINS') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const base = this.config.get<string>('PUBLIC_BASE_URL') || '';
    const hosts = new Set<string>();
    for (const u of [base, ...allowed]) { try { if (u) hosts.add(new URL(u).host); } catch {} }
    if (!hosts.size) return true; // not configured → allow
    const src = (req.headers['origin'] as string) || (req.headers['referer'] as string) || '';
    if (!src) return true; // same-origin / non-browser → allow
    try { return hosts.has(new URL(src).host); } catch { return false; }
  }

  @Post()
  async chat(@Body() body: { messages?: { role: string; content: string }[]; sub?: string; lang?: string }, @Req() req: Request) {
    if (!this.originOk(req)) throw new HttpException('origin not allowed', HttpStatus.FORBIDDEN);
    const sub = body?.sub || '';
    // Rate-limit: max ~20 user messages/minute per visitor.
    if (sub) { const recent = await this.svc.messageCountSince(sub, 60000); if (recent > 20) throw new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS); }
    return this.svc.reply(body?.messages || [], sub, body?.lang);
  }

  // Restore dialog history on return (§8 of Part I).
  @Get('history')
  async history(@Query('sub') sub?: string) {
    return this.svc.history(sub || '');
  }

  // Chat funnel by goal_state for the admin dashboard (§I.12).
  @Get('funnel')
  async funnel(@Query('key') key?: string) {
    const admin = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN');
    if (!admin || key !== admin) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);
    return this.svc.chatFunnel();
  }

  // Leads captured by the chat bot (contacts + the client's request) — admin dashboard list.
  @Get('leads')
  async leads(@Query('key') key?: string) {
    const admin = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN');
    if (!admin || key !== admin) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);
    return { leads: await this.svc.leads() };
  }

  // Admin-configurable notification channel (Telegram chat id / email) for new leads.
  @Get('settings')
  async getSettings(@Query('key') key?: string) {
    const admin = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN');
    if (!admin || key !== admin) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);
    return this.svc.getAdminSettings();
  }
  @Post('settings')
  async saveSettings(@Body() body: { key?: string; telegramChatId?: string; adminEmail?: string }) {
    const admin = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN');
    if (!admin || body?.key !== admin) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);
    return { ok: await this.svc.saveAdminSettings({ telegramChatId: body?.telegramChatId, adminEmail: body?.adminEmail }) };
  }

  @Post('lead')
  async lead(@Body() body: any) {
    return this.svc.saveLead(body || {});
  }

  // Privacy (§11): erase this visitor's data.
  @Post('forget')
  async forget(@Body() body: { sub?: string }) {
    return this.svc.forget(body?.sub || '');
  }

  // Standalone reminder creation (§9).
  @Post('reminder')
  async reminder(@Body() body: any) {
    return this.svc.scheduleReminder(body || {});
  }

  // Reminders dispatch (pg_cron target).
  @Post('reminders/dispatch')
  async dispatchPost(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.cronOk(auth, xsec)) throw new HttpException('invalid cron secret', HttpStatus.UNAUTHORIZED);
    return { ok: true, ...(await this.svc.dispatchReminders()) };
  }
  @Get('reminders/dispatch')
  async dispatchGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.cronOk(auth, xsec)) throw new HttpException('invalid cron secret', HttpStatus.UNAUTHORIZED);
    return { ok: true, ...(await this.svc.dispatchReminders()) };
  }
  private cronOk(auth?: string, xsec?: string): boolean {
    const s = this.config.get<string>('CRON_SECRET');
    return !!s && (auth === `Bearer ${s}` || xsec === s);
  }
}
