import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

const CHUNK = 8 * 1024 * 1024;   // 8 MiB — multiple of 256 KiB, as YouTube requires for non-final chunks

/**
 * Background publish queue for slow networks (Instagram / YouTube). Each job is advanced by ONE short
 * step per call (advanceJob), so no single request outlasts the serverless timeout:
 *  - Instagram: create REELS container → poll status → publish.
 *  - YouTube:   resumable upload, ONE 8 MiB chunk per step (works for arbitrarily large files).
 * The same stepper is driven by client polling (POST /api/publish/job) and by the daily cron
 * (processPending + cleanupStuck), so jobs progress even if nobody is watching.
 */
@Injectable()
export class PublishJobsService {
  private readonly logger = new Logger(PublishJobsService.name);
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  async enqueue(network: string, videoUrl: string, caption: string, target: string, title: string) {
    const job = await this.prisma.publishJob.create({
      data: { network, videoUrl, caption, target: target || null, status: 'queued', stepData: { title } as any },
    });
    return { ok: true, status: 'queued', jobId: job.id, message: 'в очереди — идёт фоновая публикация' };
  }

  async advanceJob(id: string) {
    const j = await this.prisma.publishJob.findUnique({ where: { id } });
    if (!j) return { status: 'error', message: 'задача не найдена' };
    if (j.status === 'done') return { status: 'done', postId: j.postId, message: 'готово' };
    if (j.status === 'error') return { status: 'error', message: j.error || 'ошибка' };
    const step = ((j.stepData as any) || {});
    try {
      if (j.network === 'instagram') return await this.advanceIg(j, step);
      if (j.network === 'youtube') return await this.advanceYt(j, step);
      await this.failJob(j.id, 'unknown network'); return { status: 'error', message: 'неизвестная сеть' };
    } catch (e: any) {
      await this.failJob(j.id, String(e?.message || e)); return { status: 'error', message: String(e?.message || e) };
    }
  }

  private async failJob(id: string, msg: string) { await this.prisma.publishJob.update({ where: { id }, data: { status: 'error', error: String(msg).slice(0, 400) } }).catch(() => {}); }
  private async doneJob(id: string, postId: string) { await this.prisma.publishJob.update({ where: { id }, data: { status: 'done', postId } }).catch(() => {}); }
  private async touch(id: string, data: any) { await this.prisma.publishJob.update({ where: { id }, data }).catch(() => {}); }

  // ── Instagram Reels: container → status → publish ──
  private async advanceIg(j: any, step: any) {
    const ig = this.config.get<string>('IG_USER_ID') || '';
    const token = this.config.get<string>('IG_ACCESS_TOKEN') || this.config.get<string>('FB_PAGE_TOKEN') || '';
    if (!ig || !token) { await this.failJob(j.id, 'нужны IG_USER_ID и IG_ACCESS_TOKEN/FB_PAGE_TOKEN'); return { status: 'error', message: 'IG не настроен на сервере' }; }
    if (!step.creationId) {
      const cj: any = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(ig)}/media`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_type: 'REELS', video_url: j.videoUrl, caption: j.caption || '', access_token: token }),
      }).then((r) => r.json());
      if (!cj?.id) { await this.failJob(j.id, cj?.error?.message || 'не создан контейнер IG'); return { status: 'error', message: cj?.error?.message || 'не создан контейнер IG' }; }
      await this.touch(j.id, { status: 'processing', lockedAt: new Date(), stepData: { ...step, creationId: cj.id } });
      return { status: 'processing', message: 'IG: видео загружается…' };
    }
    const st: any = await fetch(`https://graph.facebook.com/v20.0/${step.creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`).then((r) => r.json()).catch(() => null);
    if (st?.status_code === 'ERROR') { await this.failJob(j.id, 'IG обработка завершилась ошибкой'); return { status: 'error', message: 'IG обработка завершилась ошибкой' }; }
    if (st?.status_code !== 'FINISHED') { await this.touch(j.id, { lockedAt: new Date() }); return { status: 'processing', message: 'IG обрабатывает видео…' }; }
    const pj: any = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(ig)}/media_publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: step.creationId, access_token: token }),
    }).then((r) => r.json());
    if (pj?.id) { await this.doneJob(j.id, String(pj.id)); return { status: 'done', postId: String(pj.id), message: 'отправлено (Reels)' }; }
    await this.failJob(j.id, pj?.error?.message || 'не опубликовано'); return { status: 'error', message: pj?.error?.message || 'не опубликовано' };
  }

  // ── YouTube Shorts: resumable upload, one chunk per step ──
  private async advanceYt(j: any, step: any) {
    const at = await this.ytAccessToken();
    if (!at) { await this.failJob(j.id, 'нужны YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN'); return { status: 'error', message: 'YouTube не настроен на сервере' }; }

    // Phase 1 — open a resumable session (needs the total size up front).
    if (!step.sessionUri) {
      const total = await this.contentLength(j.videoUrl);
      if (!total) { await this.failJob(j.id, 'не удалось определить размер видео'); return { status: 'error', message: 'не удалось определить размер видео' }; }
      const meta = JSON.stringify({
        snippet: { title: String(step.title || 'ATM-travel').slice(0, 90) + ' #Shorts', description: (j.caption || '') + '\n#Shorts', categoryId: '19' },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      });
      const r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(total), 'X-Upload-Content-Type': 'video/mp4' },
        body: meta,
      });
      const loc = r.headers.get('location');
      if (!loc) { await this.failJob(j.id, `нет resumable-сессии (HTTP ${r.status})`); return { status: 'error', message: 'YouTube не открыл сессию загрузки' }; }
      await this.touch(j.id, { status: 'processing', lockedAt: new Date(), stepData: { ...step, sessionUri: loc, total, offset: 0 } });
      return { status: 'processing', message: 'YouTube: сессия создана' };
    }

    // Phase 2 — upload the next chunk (fetched from the Blob via a Range request).
    const total: number = step.total;
    const offset: number = step.offset || 0;
    const end = Math.min(offset + CHUNK, total) - 1;
    const part = Buffer.from(await (await fetch(j.videoUrl, { headers: { Range: `bytes=${offset}-${end}` } })).arrayBuffer());
    const put = await fetch(step.sessionUri, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end}/${total}` }, body: part });
    if (put.status === 308) {
      let next = offset + part.length;
      const rh = put.headers.get('range'); const m = rh && /bytes=0-(\d+)/.exec(rh); if (m) next = parseInt(m[1], 10) + 1;
      await this.touch(j.id, { lockedAt: new Date(), stepData: { ...step, offset: next } });
      return { status: 'processing', message: `YouTube: загружено ${Math.round((next / total) * 100)}%` };
    }
    if (put.ok) {
      const uj: any = await put.json().catch(() => null);
      if (uj?.id) { await this.doneJob(j.id, String(uj.id)); return { status: 'done', postId: String(uj.id), message: 'отправлено (Shorts)' }; }
      await this.failJob(j.id, 'загрузка завершена, но YouTube не вернул id'); return { status: 'error', message: 'YouTube не вернул id' };
    }
    await this.failJob(j.id, `YouTube upload HTTP ${put.status}`); return { status: 'error', message: `YouTube upload HTTP ${put.status}` };
  }

  async ytAccessToken(): Promise<string | null> {
    const cid = this.config.get<string>('YOUTUBE_CLIENT_ID'), csec = this.config.get<string>('YOUTUBE_CLIENT_SECRET'), rt = this.config.get<string>('YOUTUBE_REFRESH_TOKEN');
    if (!cid || !csec || !rt) return null;
    const j: any = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rt, grant_type: 'refresh_token' }),
    }).then((r) => r.json()).catch(() => null);
    return j?.access_token || null;
  }

  private async contentLength(url: string): Promise<number> {
    try { const h = await fetch(url, { method: 'HEAD' }); const cl = Number(h.headers.get('content-length')); if (cl > 0) return cl; } catch {}
    try { const r = await fetch(url, { headers: { Range: 'bytes=0-0' } }); const cr = r.headers.get('content-range'); const m = cr && /\/(\d+)\s*$/.exec(cr); if (m) return parseInt(m[1], 10); } catch {}
    return 0;
  }

  // ── Cron helpers ──
  /** Advance pending jobs a few steps each so they progress without a client watching. */
  async processPending(maxJobs = 10, stepsPerJob = 6): Promise<number> {
    const jobs = await this.prisma.publishJob.findMany({
      where: { status: { in: ['queued', 'processing'] } }, orderBy: { createdAt: 'asc' }, take: maxJobs,
    }).catch(() => [] as any[]);
    let advanced = 0;
    for (const j of jobs) {
      for (let s = 0; s < stepsPerJob; s++) {
        const r: any = await this.advanceJob(j.id).catch(() => null);
        advanced++;
        if (!r || r.status === 'done' || r.status === 'error') break;
      }
    }
    return advanced;
  }

  /** Fail jobs stuck in queued/processing beyond maxAgeMin (no forward progress). */
  async cleanupStuck(maxAgeMin = 60): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMin * 60_000);
    const res = await this.prisma.publishJob.updateMany({
      where: { status: { in: ['queued', 'processing'] }, updatedAt: { lt: cutoff } },
      data: { status: 'error', error: 'timeout: задача застряла и снята автоматически' },
    }).catch(() => ({ count: 0 } as any));
    return res.count || 0;
  }
}
