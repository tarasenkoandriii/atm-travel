import { Body, Controller, Get, Param, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AudioService } from '../audio/audio.service';
import type { AudioProviderId, AudioRequest } from '../audio/audio.types';
import { HotToursService } from '../hottours/hottours.service';
import { ReelClipsService } from './reel-clips.service';

type Clip = { provider: string; id: string; url: string; attribution: string; tags: string[]; w?: number; h?: number };

/**
 * CORS proxy for reel assets + automatic stock-clip sourcing (Pexels/Pixabay) so the montage can
 * pull relevant B-roll by destination instead of pasting URLs by hand. Server-side keys only.
 */
@Controller('api/reels')
export class ReelController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audio: AudioService,
    private readonly hotTours: HotToursService,
    private readonly reelClips: ReelClipsService,
  ) {}

  // Available tours/hotels/flights for a destination (by country code) — reel slide source.
  @Get('tours')
  async tours(@Query('cc') cc?: string) {
    return { tours: await this.hotTours.toursForDestination((cc || '').trim()) };
  }

  // Saved reels with optional origin/destination/date filters (admin-gated). For targeted-ad planning.
  @Get('list')
  async listReels(@Query('key') key?: string, @Query('origin') origin?: string, @Query('dest') dest?: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (!this.hotTours.adminAllowed(key)) throw new UnauthorizedException();
    const and: any[] = [];
    if (origin) and.push({ OR: [{ originCityId: origin.toUpperCase() }, { originLabel: { contains: origin, mode: 'insensitive' } }] });
    if (dest) and.push({ OR: [{ destCityId: dest.toUpperCase() }, { destLabel: { contains: dest, mode: 'insensitive' } }] });
    if (from || to) { const dd: any = {}; if (from) dd.gte = new Date(from); if (to) dd.lte = new Date(to); and.push({ departDate: dd }); }
    const rows = await this.prisma.reel.findMany({ where: and.length ? { AND: and } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
    return {
      reels: rows.map((r) => ({
        id: r.id, title: r.title, originCityId: r.originCityId, destCityId: r.destCityId,
        originLabel: r.originLabel, destLabel: r.destLabel, departDate: r.departDate, returnDate: r.returnDate,
        createdAt: r.createdAt, formats: r.formats, tour: r.tourJson, clipSetId: r.clipSetId,
      })),
    };
  }

  // Persist a generated reel with origin/destination cities + dates (for later targeted ads).
  @Post('save')
  async save(@Body() b: any) {
    const r = await this.prisma.reel.create({
      data: {
        title: b?.title || null,
        originCityId: b?.originCityId || null, destCityId: b?.destCityId || null,
        originLabel: b?.originLabel || null, destLabel: b?.destLabel || null,
        departDate: b?.departDate ? new Date(b.departDate) : null,
        returnDate: b?.returnDate ? new Date(b.returnDate) : null,
        tourJson: b?.tour ?? undefined, clipSetId: b?.clipSetId || null, formats: b?.formats ?? undefined,
      },
    });
    return { id: r.id };
  }

  // Short-lived clip selection: /cine POSTs the chosen clips, gets an id, and passes ?clipset=<id>
  // to /reels instead of a long base64 ?clips URL.
  @Post('clipset')
  async createClipset(@Body() body: { clips?: any[] }) {
    const clips = Array.isArray(body?.clips) ? body.clips.slice(0, 40) : [];
    const row = await this.prisma.clipSet.create({ data: { items: clips as any } });
    return { id: row.id };
  }

  @Get('clipset/:id')
  async getClipset(@Param('id') id: string) {
    const row = await this.prisma.clipSet.findUnique({ where: { id } });
    return { clips: row ? (row.items as any) : [] };
  }

  // Suggested soundtrack candidates (Jamendo/Freesound/Mubert via AudioModule). The UI lists them
  // with listen/select; only one track is used as the reel's soundtrack.
  @Post('audio')
  async audioCandidates(@Body() body: {
    query?: string; mood?: string[]; genre?: string[];
    bpmRange?: [number, number]; durationSec?: number;
    prefer?: AudioProviderId[]; limit?: number;
  }) {
    if (!this.audio.enabled) return { configured: false, tracks: [] };
    const req: AudioRequest = {
      kind: 'music',
      query: body?.query,
      mood: body?.mood,
      genre: body?.genre,
      bpmRange: body?.bpmRange,
      durationSec: body?.durationSec,
      commercialUseRequired: true,
    };
    try {
      const tracks = await this.audio.candidates(req, body?.prefer, Math.min(12, body?.limit || 8));
      return {
        configured: true,
        tracks: tracks.map((t) => ({
          provider: t.provider,
          id: t.providerTrackId,
          title: t.title,
          artist: t.artist || '',
          durationSec: t.durationSec,
          bpm: t.bpm ?? null,
          previewUrl: t.previewUrl || t.audioUrl,
          audioUrl: t.audioUrl,
          attribution: t.license.attributionRequired
            ? (t.license.attributionText || `${t.title}${t.artist ? ' — ' + t.artist : ''} (${t.license.type})`)
            : '',
          requiresPaidLicense: t.license.requiresPaidLicense === true,
        })),
      };
    } catch (e: any) {
      return { configured: true, tracks: [], error: String(e?.message || e) };
    }
  }

  // Grok AI analysis of the finished montage: the browser samples a few frames and posts them here,
  // we ask xAI (vision) for a 0-100 score, improvement tips, and a short blog article.
  @Post('analyze')
  async analyze(@Body() body: {
    frames?: string[]; title?: string; attributions?: string[];
    durationSec?: number; formats?: string[]; clips?: number; langName?: string;
  }) {
    const key = this.config.get<string>('XAI_API_KEY');
    if (!key) return { error: 'Grok не настроен (XAI_API_KEY)' };
    const frames = (Array.isArray(body?.frames) ? body.frames : []).filter((f) => typeof f === 'string' && f.startsWith('data:image')).slice(0, 6);
    if (!frames.length) return { error: 'нет кадров для анализа' };
    const lang = body?.langName || 'русском';

    const meta = [
      body?.title ? `Локация/заголовок: ${body.title}` : '',
      body?.durationSec ? `Длительность: ${body.durationSec} c` : '',
      body?.clips != null ? `Клипов в нарезке: ${body.clips}` : '',
      body?.formats?.length ? `Форматы: ${body.formats.join(', ')}` : '',
      body?.attributions?.length ? `Источники футажа: ${body.attributions.join('; ')}` : '',
    ].filter(Boolean).join('\n');

    const sys = 'Ты — эксперт по коротким travel-видео (Reels/TikTok/Shorts) для сервиса живых камер мира ATM-travel. ' +
      'Тебе дают несколько кадров одного вертикального ролика (интро-глобус → нарезка стоковых клипов по локации → живая камера) и метаданные. ' +
      'Оценивай честно и по делу. Верни СТРОГО JSON без markdown-ограждений и без текста вокруг.';
    const userText =
      `Кадры ролика идут по порядку. Метаданные:\n${meta || '(нет)'}\n\n` +
      `Верни JSON строго такого вида:\n` +
      `{"score": <целое 0-100 — общая оценка качества и виральности>,` +
      `"recommendations": "<конкретные рекомендации по улучшению маркированным списком: хук/первый кадр, темп и длина планов, цвет/экспозиция, текстовые подписи, звук/музыка, призыв к действию — на ${lang} языке>",` +
      `"article": "<небольшая статья для блога, 120-180 слов, вовлекающая, про эту локацию и ролик, с призывом посмотреть живую камеру на ATM-travel — на ${lang} языке>"}\n` +
      `Только JSON, ничего кроме него.`;

    const content: any[] = [{ type: 'text', text: userText }];
    for (const f of frames) content.push({ type: 'image_url', image_url: { url: f, detail: 'low' } });

    try {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'system', content: sys }, { role: 'user', content }] }),
      });
      if (!resp.ok) { const t = await resp.text().catch(() => ''); return { error: `xAI ${resp.status}${t ? ': ' + t.slice(0, 200) : ''}` }; }
      const data: any = await resp.json();
      const rawTxt = data?.choices?.[0]?.message?.content || '';
      const parsed = this.parseJson(rawTxt);
      if (parsed) {
        return {
          score: this.clampScore(parsed.score),
          recommendations: this.asText(parsed.recommendations),
          article: this.asText(parsed.article),
        };
      }
      return { raw: String(rawTxt).slice(0, 4000) };
    } catch (e: any) {
      return { error: 'Grok недоступен: ' + String(e?.message || e) };
    }
  }

  private parseJson(s: string): any {
    if (!s) return null;
    let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
    return null;
  }
  private clampScore(v: any): number | null {
    const n = Math.round(Number(v));
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  private asText(v: any): string {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? '• ' + x : JSON.stringify(x))).join('\n');
    return String(v);
  }

  private readonly allow = [
    'pexels.com', 'pixabay.com', 'coverr.co', 'mixkit.co', 'cdn.coverr.co',
    'player.vimeo.com', 'videos.pexels.com', 'cdn.pixabay.com',
    'vercel-storage.com', 'public.blob.vercel-storage.com',
  ];
  private readonly MAX = 80 * 1024 * 1024;

  // Auto-source B-roll for the "нарезка" between the globe intro and the live camera.
  @Get('clips')
  async clips(@Query('q') q: string, @Query('n') n: string, @Query('orientation') orientation: string, @Query('shots') shots: string) {
    const provider = this.reelClips.provider();
    if (!provider) return { provider: null, clips: [] };
    const count = Math.min(6, Math.max(1, parseInt(n || '4', 10)));
    const shotList = (shots || 'establishing,hero,human_detail,emotional_peak').split(',').map((s) => s.trim());
    const SUF: Record<string, string> = { establishing: 'aerial drone', hero: 'cinematic landmark', human_detail: 'street detail slowmo', emotional_peak: 'sunset golden hour' };
    const { base, fallbackBase } = this.reelClips.resolvePlaceEn(q);
    const terms = shotList.slice(0, count).map((sh) => ({
      shot: sh,
      term: (base ? base + ' ' : 'travel ') + (SUF[sh] || ''),
      fallback: (fallbackBase && fallbackBase !== 'travel' ? fallbackBase + ' ' : 'travel ') + (SUF[sh] || 'cinematic'),
    }));

    const seen = new Set<string>(); const out: Clip[] = [];
    for (const t of terms) {
      let c = await this.reelClips.findOne(t.term, orientation).catch(() => null);
      if (!c) c = await this.reelClips.findOne(t.fallback, orientation).catch(() => null);
      if (c && !seen.has(c.id)) { seen.add(c.id); c.tags = [t.shot]; out.push(c); }
      if (out.length >= count) break;
    }
    return { provider, query: base, clips: out };
  }

  @Get('proxy')
  async proxy(@Query('url') url: string, @Res() res: Response) {
    let u: URL;
    try { u = new URL(url); } catch { return res.status(400).json({ error: 'bad url' }); }
    if (u.protocol !== 'https:') return res.status(400).json({ error: 'https only' });
    const host = u.hostname.toLowerCase();
    if (!this.allow.some((d) => host === d || host.endsWith('.' + d))) {
      return res.status(403).json({ error: 'host not allowed' });
    }
    let upstream: any;
    try { upstream = await fetch(u.toString(), { redirect: 'follow' }); }
    catch { return res.status(502).json({ error: 'upstream fetch failed' }); }
    if (!upstream.ok) return res.status(502).json({ error: 'upstream ' + upstream.status });
    const len = Number(upstream.headers.get('content-length') || '0');
    if (len && len > this.MAX) return res.status(413).json({ error: 'asset too large' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    if (len) res.setHeader('Content-Length', String(len));
    // Stream the body through instead of buffering the whole file in memory first — large video
    // clips otherwise sat waiting for a full download+buffer before the browser saw a single byte,
    // which on a serverless function's execution-time budget could make the request hang/time out
    // with no error ever reaching the <video> element (it just never fires loadeddata/error).
    if (!upstream.body) { const buf = Buffer.from(await upstream.arrayBuffer()); return res.send(buf); }
    try {
      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(upstream.body as any);
      nodeStream.on('error', () => { try { res.end(); } catch {} });
      nodeStream.pipe(res);
    } catch {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.send(buf);
    }
  }
}
