import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PublishJobsService } from './publish-jobs.service';

type Net = 'telegram' | 'whatsapp' | 'viber' | 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'vk' | 'ok' | 'dzen' | 'rutube';

/**
 * Publishes a generated reel package (a CineRender set of per-format video URLs) to social networks.
 * Telegram/Facebook are posted inline (fast); Instagram/YouTube go through PublishJobsService (a
 * background queue advanced step-by-step, so large uploads never outlast the serverless timeout).
 */
@Controller('api/publish')
export class PublishController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly jobs: PublishJobsService,
  ) {}

  /** Which networks are ready (server creds present) — for the UI + "send to all". */
  @Get('config')
  configStatus() {
    const has = (k: string) => !!this.config.get<string>(k);
    return {
      telegramReady: has('TELEGRAM_BOT_TOKEN'), telegramGroup: has('TELEGRAM_GROUP_CHAT_ID'),
      facebook: has('FB_PAGE_ID') && has('FB_PAGE_TOKEN'),
      instagram: has('IG_USER_ID') && (has('IG_ACCESS_TOKEN') || has('FB_PAGE_TOKEN')),
      youtube: has('YOUTUBE_CLIENT_ID') && has('YOUTUBE_CLIENT_SECRET') && has('YOUTUBE_REFRESH_TOKEN'),
      vk: has('VK_ACCESS_TOKEN') && has('VK_GROUP_ID'),
      ok: has('OK_ACCESS_TOKEN') && has('OK_APP_KEY') && has('OK_APP_SECRET') && has('OK_GROUP_ID'),
    };
  }

  /** Resolve the video URL: a direct videoUrl wins, else the best format of a package (9:16). */
  private async video(pkg: string, videoUrl?: string, title?: string): Promise<{ url: string; title: string } | null> {
    if (videoUrl) return { url: videoUrl, title: title || 'ATM-travel' };
    if (!pkg) return null;
    const row = await this.prisma.cineRender.findUnique({ where: { id: pkg } });
    if (!row) return null;
    const items = ((row.items as any[]) || []).filter((i) => i && i.url);
    const pick = items.find((i) => i.format === '9:16') || items[0];
    return pick ? { url: pick.url, title: (row as any).title || title || 'ATM-travel' } : null;
  }

  @Post()
  async publish(@Body() body: { pkg?: string; network?: Net; target?: string; caption?: string; videoUrl?: string; title?: string }) {
    const network = body?.network as Net;
    const vid = await this.video(body?.pkg || '', body?.videoUrl || '', body?.title || '');
    if (!vid) return { ok: false, status: 'error', message: 'пакет не найден или пуст' };
    const title = body?.title || vid.title;
    const caption = (body?.caption || title || '').slice(0, 900);

    switch (network) {
      case 'telegram':  return this.telegram(body?.target || '', vid.url, caption);
      case 'facebook':  return this.facebook(body?.target || '', vid.url, caption);
      case 'vk':        return this.vk(body?.target || '', vid.url, caption, title);
      case 'ok':        return this.ok(body?.target || '', vid.url, caption, title);
      case 'instagram':
      case 'youtube':
        return this.jobs.enqueue(network, vid.url, caption, body?.target || '', title);   // slow → background queue
      case 'dzen':
        return { ok: false, status: 'todo', message: 'Дзен (ex-Яндекс.Дзен, теперь VK) не имеет REST-API постинга видео — публикация идёт через RSS-ингест канала или Dzen Studio. См. docs/social-russia.md.' };
      case 'rutube':
        return { ok: false, status: 'todo', message: 'Rutube: постинг возможен через его Upload API (нужен OAuth-доступ издателя) — в дорожной карте. См. docs/social-russia.md.' };
      case 'whatsapp':
      case 'viber':
      case 'tiktok':
        return { ok: false, status: 'todo', message: `Интеграция «${network}» появится позже (нужен OAuth/токен провайдера)` };
      default:
        return { ok: false, status: 'error', message: 'неизвестная сеть' };
    }
  }

  @Post('remove')
  async remove(@Body() body: { network?: Net; target?: string; postId?: string }) {
    switch (body?.network) {
      case 'telegram': return this.telegramRemove(body?.target || '', body?.postId || '');
      case 'facebook': return this.facebookRemove(body?.postId || '');
      case 'youtube':  return this.youtubeRemove(body?.postId || '');
      case 'vk':       return this.vkRemove(body?.target || '', body?.postId || '');
      case 'ok':       return this.okRemove(body?.postId || '');
      default: return { ok: false, status: 'todo', message: `Удаление для «${body?.network || '?'}» пока не реализовано` };
    }
  }

  // Advance one background job by a single short step (client polls this until done/error).
  @Post('job')
  async job(@Body() body: { id?: string }) {
    if (!body?.id) return { status: 'error', message: 'нет id задачи' };
    return this.jobs.advanceJob(body.id);
  }

  // Protected queue tick for an external scheduler (Supabase pg_cron / any cron-ping). Runs more often
  // than the daily refresh so IG/YouTube jobs progress without a client watching. Guarded by CRON_SECRET
  // (Authorization: Bearer <secret> OR x-cron-secret: <secret>) — the same secret as /api/cron/refresh.
  @Post('queue/tick')
  async queueTickPost(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    return this.runQueueTick(auth, xsec);
  }
  @Get('queue/tick')
  async queueTickGet(@Headers('authorization') auth?: string, @Headers('x-cron-secret') xsec?: string) {
    return this.runQueueTick(auth, xsec);
  }
  private async runQueueTick(auth?: string, xsec?: string) {
    const secret = this.config.get<string>('CRON_SECRET');
    if (!(auth === `Bearer ${secret}` || xsec === secret)) throw new UnauthorizedException('Invalid cron secret');
    const stuck = await this.jobs.cleanupStuck(60);
    const advanced = await this.jobs.processPending(20, 8);
    return { ok: true, advanced, stuck };
  }

  // ── Facebook Page (Graph API): post the hosted video by URL ──
  private async facebook(pageOverride: string, videoUrl: string, caption: string) {
    const token = this.config.get<string>('FB_PAGE_TOKEN');
    const pageId = pageOverride || this.config.get<string>('FB_PAGE_ID') || '';
    if (!token || !pageId) return { ok: false, status: 'error', message: 'нужны FB_PAGE_ID и FB_PAGE_TOKEN на сервере' };
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}/videos`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_url: videoUrl, description: caption, access_token: token }),
      });
      const j: any = await r.json();
      if (j?.id) return { ok: true, status: 'ok', message: 'отправлено', postId: String(j.id) };
      return { ok: false, status: 'error', message: j?.error?.message || `HTTP ${r.status}`, raw: j };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  private async facebookRemove(videoId: string) {
    const token = this.config.get<string>('FB_PAGE_TOKEN');
    if (!token || !videoId) return { ok: false, status: 'error', message: 'нет токена / id' };
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(videoId)}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
      const j: any = await r.json();
      return (j?.success || j?.id) ? { ok: true, status: 'ok', message: 'удалено' } : { ok: false, status: 'error', message: j?.error?.message || 'ошибка удаления' };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  // ── VKontakte: register the video by external URL (video.save link) → wall.post on the community ──
  private async vk(groupOverride: string, videoUrl: string, caption: string, title?: string) {
    const token = this.config.get<string>('VK_ACCESS_TOKEN');
    const gid = (groupOverride || this.config.get<string>('VK_GROUP_ID') || '').replace(/^-/, '');
    if (!token || !gid) return { ok: false, status: 'error', message: 'нужны VK_ACCESS_TOKEN и VK_GROUP_ID на сервере' };
    const v = this.config.get<string>('VK_API_VERSION') || '5.199';
    const api = async (method: string, params: Record<string, string>): Promise<any> => {
      const qs = new URLSearchParams({ ...params, access_token: token, v }).toString();
      return fetch(`https://api.vk.com/method/${method}?${qs}`).then((r) => r.json());
    };
    try {
      // 1) create a community video from the external link
      const save = await api('video.save', { link: videoUrl, name: (title || caption || 'ATM-travel').slice(0, 128), description: caption, group_id: gid, wallpost: '0' });
      if (save?.error) return { ok: false, status: 'error', message: `video.save: ${save.error.error_msg}`, raw: save };
      const up = save.response || {};
      // 2) hit upload_url once so VK imports the external link (no file body for the link flow)
      if (up.upload_url) await fetch(up.upload_url).catch(() => {});
      const owner = up.owner_id ?? `-${gid}`; const vidId = up.video_id;
      if (!vidId) return { ok: false, status: 'error', message: 'VK не вернул video_id', raw: save };
      // 3) publish a wall post on the community with the video attachment
      const post = await api('wall.post', { owner_id: `-${gid}`, from_group: '1', message: caption, attachments: `video${owner}_${vidId}` });
      if (post?.error) return { ok: false, status: 'error', message: `wall.post: ${post.error.error_msg}`, raw: post };
      return { ok: true, status: 'ok', message: 'отправлено', postId: String(post.response?.post_id ?? `${owner}_${vidId}`) };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  private async vkRemove(groupOverride: string, postId: string) {
    const token = this.config.get<string>('VK_ACCESS_TOKEN');
    const gid = (groupOverride || this.config.get<string>('VK_GROUP_ID') || '').replace(/^-/, '');
    if (!token || !gid || !postId) return { ok: false, status: 'error', message: 'нет токена / group / post_id' };
    const v = this.config.get<string>('VK_API_VERSION') || '5.199';
    const wallId = postId.includes('_') ? postId.split('_').pop()! : postId;   // accept wall id or "<owner>_<video>"
    try {
      const j: any = await fetch(`https://api.vk.com/method/wall.delete?${new URLSearchParams({ owner_id: `-${gid}`, post_id: wallId, access_token: token, v })}`).then((r) => r.json());
      return j?.response === 1 ? { ok: true, status: 'ok', message: 'удалено' } : { ok: false, status: 'error', message: j?.error?.error_msg || 'ошибка удаления' };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  // ── Odnoklassniki (OK.ru) REST: MD5-signed calls to fb.do ──
  private md5(s: string): string { return createHash('md5').update(s, 'utf8').digest('hex'); }
  private async okCall(method: string, params: Record<string, string>): Promise<any> {
    const token = this.config.get<string>('OK_ACCESS_TOKEN') || '';
    const appKey = this.config.get<string>('OK_APP_KEY') || '';
    const secret = this.config.get<string>('OK_APP_SECRET') || '';
    const p: Record<string, string> = { application_key: appKey, format: 'json', method, ...params };
    const sigBase = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('');       // sorted, access_token excluded
    const sig = this.md5(sigBase + this.md5(token + secret));
    const body = new URLSearchParams({ ...p, sig, access_token: token });
    return fetch('https://api.ok.ru/fb.do', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }).then((r) => r.json());
  }

  // getUploadUrl → upload the hosted reel bytes → mediatopic.post into the group feed
  private async ok(groupOverride: string, videoUrl: string, caption: string, title?: string) {
    const token = this.config.get<string>('OK_ACCESS_TOKEN');
    const appKey = this.config.get<string>('OK_APP_KEY');
    const secret = this.config.get<string>('OK_APP_SECRET');
    const gid = groupOverride || this.config.get<string>('OK_GROUP_ID') || '';
    if (!token || !appKey || !secret || !gid) return { ok: false, status: 'error', message: 'нужны OK_ACCESS_TOKEN, OK_APP_KEY, OK_APP_SECRET, OK_GROUP_ID' };
    try {
      const gu = await this.okCall('video.getUploadUrl', { gid, name: (title || caption || 'ATM-travel').slice(0, 100) });
      if (gu?.error_code) return { ok: false, status: 'error', message: `getUploadUrl: ${gu.error_msg}`, raw: gu };
      const uploadUrl = gu.upload_url; const videoId = String(gu.video_id ?? '');
      if (!uploadUrl || !videoId) return { ok: false, status: 'error', message: 'OK не вернул upload_url/video_id', raw: gu };
      // download the hosted reel and upload the bytes (short vertical clips fit the serverless window)
      const bytes = await fetch(videoUrl).then((r) => r.arrayBuffer());
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'reel.mp4');
      const upResp = await fetch(uploadUrl, { method: 'POST', body: form });
      if (!upResp.ok) return { ok: false, status: 'error', message: `upload HTTP ${upResp.status}` };
      const attachment = JSON.stringify({ media: [{ type: 'text', text: caption }, { type: 'movie', movieId: videoId }] });
      const mp = await this.okCall('mediatopic.post', { type: 'GROUP_THEME', gid, attachment });
      if (mp?.error_code) return { ok: false, status: 'error', message: `mediatopic.post: ${mp.error_msg}`, raw: mp };
      return { ok: true, status: 'ok', message: 'отправлено', postId: videoId, topicId: typeof mp === 'string' ? mp : String(mp?.id ?? '') };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  private async okRemove(videoId: string) {
    if (!this.config.get<string>('OK_ACCESS_TOKEN') || !videoId) return { ok: false, status: 'error', message: 'нет creds / video id' };
    try {
      const j = await this.okCall('video.delete', { vid: videoId });
      return j === true || j?.success ? { ok: true, status: 'ok', message: 'удалено' } : { ok: false, status: 'error', message: j?.error_msg || 'ошибка удаления', raw: j };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  // ── YouTube access token (Data API v3) ──
  private async ytAccessToken(): Promise<string | null> {
    const cid = this.config.get<string>('YOUTUBE_CLIENT_ID'), csec = this.config.get<string>('YOUTUBE_CLIENT_SECRET'), rt = this.config.get<string>('YOUTUBE_REFRESH_TOKEN');
    if (!cid || !csec || !rt) return null;
    const j: any = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rt, grant_type: 'refresh_token' }),
    }).then((r) => r.json()).catch(() => null);
    return j?.access_token || null;
  }

  private async youtubeRemove(videoId: string) {
    const at = await this.ytAccessToken();
    if (!at || !videoId) return { ok: false, status: 'error', message: 'нет creds / id' };
    try {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${at}` } });
      return r.ok ? { ok: true, status: 'ok', message: 'удалено' } : { ok: false, status: 'error', message: `HTTP ${r.status}` };
    } catch (e: any) { return { ok: false, status: 'error', message: String(e?.message || e) }; }
  }

  // ── Telegram Bot API ──────────────────────────────────────────────────────
  private async telegram(chatId: string, videoUrl: string, caption: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return { ok: false, status: 'error', message: 'TELEGRAM_BOT_TOKEN не настроен на сервере' };
    const chat = chatId || this.config.get<string>('TELEGRAM_GROUP_CHAT_ID') || '';   // fall back to own group
    if (!chat) return { ok: false, status: 'error', message: 'укажите chat_id/@канал в «Настроить» или задайте TELEGRAM_GROUP_CHAT_ID (своя группа)' };
    try {
      const u = `https://api.telegram.org/bot${token}/sendVideo?chat_id=${encodeURIComponent(chat)}` +
        `&video=${encodeURIComponent(videoUrl)}&caption=${encodeURIComponent(caption)}`;
      const r = await fetch(u);
      const j: any = await r.json();
      if (j?.ok) return { ok: true, status: 'ok', message: 'отправлено', postId: String(j.result?.message_id ?? ''), raw: j.result };
      return { ok: false, status: 'error', message: j?.description || `HTTP ${r.status}`, raw: j };
    } catch (e: any) {
      return { ok: false, status: 'error', message: String(e?.message || e) };
    }
  }

  private async telegramRemove(chatId: string, messageId: string) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const chat = chatId || this.config.get<string>('TELEGRAM_GROUP_CHAT_ID') || '';
    if (!token || !chat || !messageId) return { ok: false, status: 'error', message: 'нет токена / chat_id / message_id' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/deleteMessage?chat_id=${encodeURIComponent(chat)}&message_id=${encodeURIComponent(messageId)}`);
      const j: any = await r.json();
      return j?.ok ? { ok: true, status: 'ok', message: 'удалено' } : { ok: false, status: 'error', message: j?.description || 'ошибка удаления' };
    } catch (e: any) {
      return { ok: false, status: 'error', message: String(e?.message || e) };
    }
  }
}
