import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

type Clip = { provider: string; id: string; url: string; attribution: string; tags: string[]; w?: number; h?: number };

/**
 * CORS proxy for reel assets + automatic stock-clip sourcing (Pexels/Pixabay) so the montage can
 * pull relevant B-roll by destination instead of pasting URLs by hand. Server-side keys only.
 */
@Controller('api/reels')
export class ReelController {
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

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

  private provider(): string | null {
    if (this.config.get<string>('PEXELS_API_KEY')) return 'pexels';
    if (this.config.get<string>('PIXABAY_API_KEY')) return 'pixabay';
    return null;
  }

  // ru/uk → en place resolution so a Cyrillic title still yields relevant stock footage.
  private readonly PLACES: Record<string, string> = {
    'хургада': 'Hurghada', 'шарм-эль-шейх': 'Sharm El Sheikh', 'шарм': 'Sharm El Sheikh', 'египет': 'Egypt',
    'турция': 'Turkey', 'туреччина': 'Turkey', 'стамбул': 'Istanbul', 'анталия': 'Antalya', 'анталья': 'Antalya', 'аланья': 'Alanya',
    'дубай': 'Dubai', 'оаэ': 'UAE', 'абу-даби': 'Abu Dhabi', 'мальдивы': 'Maldives', 'мальдіви': 'Maldives',
    'таиланд': 'Thailand', 'тайланд': 'Thailand', 'пхукет': 'Phuket', 'бангкок': 'Bangkok', 'паттайя': 'Pattaya',
    'бали': 'Bali', 'индонезия': 'Indonesia', 'вьетнам': 'Vietnam', 'нячанг': 'Nha Trang',
    'киев': 'Kyiv', 'київ': 'Kyiv', 'львов': 'Lviv', 'львів': 'Lviv', 'одесса': 'Odesa', 'одеса': 'Odesa',
    'карпаты': 'Carpathians mountains', 'карпати': 'Carpathians mountains', 'буковель': 'Bukovel',
    'прага': 'Prague', 'чехия': 'Czechia', 'париж': 'Paris', 'франция': 'France', 'рим': 'Rome', 'италия': 'Italy',
    'венеция': 'Venice', 'барселона': 'Barcelona', 'испания': 'Spain', 'мадрид': 'Madrid', 'тенерифе': 'Tenerife',
    'канары': 'Canary Islands', 'кипр': 'Cyprus', 'греция': 'Greece', 'крит': 'Crete', 'родос': 'Rhodes',
    'санторини': 'Santorini', 'афины': 'Athens', 'лондон': 'London', 'вена': 'Vienna', 'австрия': 'Austria',
    'варшава': 'Warsaw', 'польша': 'Poland', 'краков': 'Krakow', 'будапешт': 'Budapest', 'амстердам': 'Amsterdam',
    'лиссабон': 'Lisbon', 'португалия': 'Portugal', 'черногория': 'Montenegro', 'хорватия': 'Croatia',
    'тунис': 'Tunisia', 'марокко': 'Morocco', 'занзибар': 'Zanzibar', 'шри-ланка': 'Sri Lanka',
    'гоа': 'Goa', 'индия': 'India', 'грузия': 'Georgia', 'тбилиси': 'Tbilisi', 'батуми': 'Batumi', 'армения': 'Armenia',
  };
  private readonly TR: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'ie', ґ: 'g',
  };
  private translit(s: string): string {
    return s.toLowerCase().split('').map((ch) => (this.TR[ch] !== undefined ? this.TR[ch] : ch)).join('').replace(/\s+/g, ' ').trim();
  }
  private resolveToken(s: string): string {
    const k = s.toLowerCase().trim(); if (!k) return '';
    if (this.PLACES[k]) return this.PLACES[k];
    if (/[а-яёіїєґ]/i.test(k)) return this.translit(k).replace(/\b\w/g, (c) => c.toUpperCase());
    return s.trim();
  }
  private resolvePlaceEn(q: string): { base: string; fallbackBase: string } {
    const parts = (q || '').split(',').map((p) => this.resolveToken(p)).filter(Boolean);
    const city = parts[0] || '', country = parts[1] || '';
    return { base: city || country || '', fallbackBase: country || 'travel' };
  }

  @Get('config')
  cfg() { return { clipsProvider: this.provider() }; }

  // Auto-source B-roll for the "нарезка" between the globe intro and the live camera.
  @Get('clips')
  async clips(@Query('q') q: string, @Query('n') n: string, @Query('orientation') orientation: string, @Query('shots') shots: string) {
    const provider = this.provider();
    if (!provider) return { provider: null, clips: [] };
    const count = Math.min(6, Math.max(1, parseInt(n || '4', 10)));
    const shotList = (shots || 'establishing,hero,human_detail,emotional_peak').split(',').map((s) => s.trim());
    const SUF: Record<string, string> = { establishing: 'aerial drone', hero: 'cinematic landmark', human_detail: 'street detail slowmo', emotional_peak: 'sunset golden hour' };
    const { base, fallbackBase } = this.resolvePlaceEn(q);
    const terms = shotList.slice(0, count).map((sh) => ({
      shot: sh,
      term: (base ? base + ' ' : 'travel ') + (SUF[sh] || ''),
      fallback: (fallbackBase && fallbackBase !== 'travel' ? fallbackBase + ' ' : 'travel ') + (SUF[sh] || 'cinematic'),
    }));

    const seen = new Set<string>(); const out: Clip[] = [];
    for (const t of terms) {
      let c = await this.search(provider, t.term, orientation).catch(() => null);
      if (!c) c = await this.search(provider, t.fallback, orientation).catch(() => null);
      if (c && !seen.has(c.id)) { seen.add(c.id); c.tags = [t.shot]; out.push(c); }
      if (out.length >= count) break;
    }
    return { provider, query: base, clips: out };
  }

  private async search(provider: string, term: string, orientation?: string): Promise<Clip | null> {
    if (provider === 'pexels') {
      const key = this.config.get<string>('PEXELS_API_KEY')!;
      const o = orientation === 'portrait' ? '&orientation=portrait' : (orientation === 'landscape' ? '&orientation=landscape' : '');
      const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(term)}&per_page=6&size=medium${o}`, { headers: { Authorization: key } });
      if (!r.ok) return null;
      const j: any = await r.json();
      const v = (j.videos || [])[0]; if (!v) return null;
      const files = (v.video_files || []).filter((f: any) => f.file_type === 'video/mp4');
      files.sort((a: any, b: any) => Math.abs((a.height || 0) - 1080) - Math.abs((b.height || 0) - 1080));
      const file = files[0]; if (!file) return null;
      return { provider, id: 'pexels-' + v.id, url: file.link, attribution: `Pexels / ${v.user?.name || 'author'}`, tags: [], w: file.width, h: file.height };
    }
    if (provider === 'pixabay') {
      const key = this.config.get<string>('PIXABAY_API_KEY')!;
      const r = await fetch(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(term)}&per_page=6`);
      if (!r.ok) return null;
      const j: any = await r.json();
      const h = (j.hits || [])[0]; if (!h) return null;
      const vids = h.videos || {};
      const pick = vids.large?.url ? vids.large : (vids.medium || vids.small || vids.tiny);
      if (!pick?.url) return null;
      return { provider, id: 'pixabay-' + h.id, url: pick.url, attribution: `Pixabay / ${h.user || 'author'}`, tags: [], w: pick.width, h: pick.height };
    }
    return null;
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
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > this.MAX) return res.status(413).json({ error: 'asset too large' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    return res.send(buf);
  }
}
