import { Body, Controller, Get, Headers, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SearchService, SearchFilter } from './search.service';

@Controller('api/search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  // AI search by direction/budget → parsed filter + matching tours.
  @Post()
  async search(@Body() body: { q?: string; sub?: string }) {
    return this.svc.search(body?.q || '', body?.sub || '');
  }

  // Save a search + subscribe (email/telegram/whatsapp).
  @Post('save')
  async save(@Body() body: { query?: string; filter?: SearchFilter; channel?: string; address?: string; sub?: string; frequency?: string; lang?: string }) {
    return this.svc.save({ query: body?.query || '', filter: body?.filter, channel: body?.channel || '', address: body?.address || '', sub: body?.sub, frequency: body?.frequency, lang: body?.lang });
  }

  // List the caller's saved searches (by client subscriber id).
  @Get('list')
  async list(@Query('sub') sub?: string) {
    return { searches: await this.svc.list(sub || '') };
  }

  @Post('remove')
  async remove(@Body() body: { token?: string }) {
    return this.svc.remove(body?.token || '');
  }

  // Manage subscriptions by token (no localStorage): all subscriptions of the same subscriber.
  @Get('manage')
  async manage(@Query('token') token?: string) {
    return this.svc.manage(token || '');
  }

  @Post('toggle')
  async toggle(@Body() body: { token?: string; active?: boolean }) {
    return this.svc.toggle(body?.token || '', body?.active !== false);
  }

  // Friendly one-click unsubscribe link (used in notifications).
  @Get('unsubscribe')
  async unsubscribe(@Query('token') token: string, @Res() res: Response) {
    await this.svc.remove(token || '');
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Отписка</title><body style="font:16px system-ui;background:#070c12;color:#e7eef4;padding:40px"><p>Подписка отменена. <a style="color:#4fd7e0" href="/">На главную</a></p></body>');
  }

  // Notify subscribers about new matches (CRON_SECRET-guarded — pg_cron target).
  @Post('notify')
  async notify(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) return { ok: false, message: 'invalid cron secret' };
    return { ok: true, ...(await this.svc.notify()) };
  }
  @Get('notify')
  async notifyGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) return { ok: false, message: 'invalid cron secret' };
    return { ok: true, ...(await this.svc.notify()) };
  }

  // Daily digest (once/day) — for subscriptions with frequency=daily.
  @Post('digest')
  async digest(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) return { ok: false, message: 'invalid cron secret' };
    return { ok: true, ...(await this.svc.digest()) };
  }
  @Get('digest')
  async digestGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) return { ok: false, message: 'invalid cron secret' };
    return { ok: true, ...(await this.svc.digest()) };
  }

  // Weekly best-of digest — for subscriptions with frequency=weekly.
  @Post('weekly')
  async weekly(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) return { ok: false, message: 'invalid cron secret' };
    return { ok: true, ...(await this.svc.weekly()) };
  }
  @Get('weekly')
  async weeklyGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    if (!this.svc.cronAllowed(auth, xsec)) return { ok: false, message: 'invalid cron secret' };
    return { ok: true, ...(await this.svc.weekly()) };
  }
}
