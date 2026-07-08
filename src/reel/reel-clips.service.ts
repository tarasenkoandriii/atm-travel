import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type Clip = { provider: string; id: string; url: string; attribution: string; tags: string[]; w?: number; h?: number };

/**
 * Shared B-roll clip search (Pexels/Pixabay) — used by ReelController's manual "/api/reels/clips"
 * endpoint AND by BlogService's automatic per-paragraph clip picker, so both go through the exact
 * same provider/fallback/place-resolution logic instead of duplicating it.
 */
@Injectable()
export class ReelClipsService {
  constructor(private readonly config: ConfigService) {}

  provider(): string | null {
    if (this.config.get<string>('PEXELS_API_KEY')) return 'pexels';
    if (this.config.get<string>('PIXABAY_API_KEY')) return 'pixabay';
    return null;
  }

  // ru/uk → en place resolution so a Cyrillic mention still yields relevant stock footage.
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
  resolvePlaceEn(q: string): { base: string; fallbackBase: string } {
    const parts = (q || '').split(',').map((p) => this.resolveToken(p)).filter(Boolean);
    const city = parts[0] || '', country = parts[1] || '';
    return { base: city || country || '', fallbackBase: country || 'travel' };
  }

  // Scan free text (a blog paragraph) for known place mentions → distinct EN names, in the order first seen.
  // Matches by STEM (drops the last 1-2 letters of the dictionary key) so Russian/Ukrainian case endings
  // ("в Анталию", "из Стамбула") still match the nominative dictionary entry ("анталия", "стамбул").
  // Used to decide how many clips a paragraph needs (one per distinct geo mentioned).
  private stemOf(key: string): string {
    return key.slice(0, Math.min(key.length, Math.max(4, key.length - 2)));
  }
  detectPlaces(text: string, max = 3): string[] {
    const words = (text || '').toLowerCase().replace(/[.,!?;:()«»"']/g, ' ').split(/\s+/).filter(Boolean);
    const seen = new Set<string>(); const out: string[] = [];
    for (const w of words) {
      for (const key of Object.keys(this.PLACES)) {
        if (w.indexOf(this.stemOf(key)) === 0) {
          const en = this.PLACES[key];
          if (!seen.has(en)) { seen.add(en); out.push(en); }
          if (out.length >= max) return out;
        }
      }
    }
    return out;
  }

  private async search(provider: string, term: string, orientation: string | undefined, pick = 0): Promise<Clip | null> {
    if (provider === 'pexels') {
      const key = this.config.get<string>('PEXELS_API_KEY')!;
      const o = orientation === 'portrait' ? '&orientation=portrait' : (orientation === 'landscape' ? '&orientation=landscape' : '');
      const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(term)}&per_page=6&size=medium${o}`, { headers: { Authorization: key } });
      if (!r.ok) return null;
      const j: any = await r.json();
      const list = j.videos || []; const v = list[Math.min(pick, list.length - 1)] || list[0]; if (!v) return null;
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
      const list = j.hits || []; const h = list[Math.min(pick, list.length - 1)] || list[0]; if (!h) return null;
      const vids = h.videos || {};
      const p = vids.large?.url ? vids.large : (vids.medium || vids.small || vids.tiny);
      if (!p?.url) return null;
      return { provider, id: 'pixabay-' + h.id, url: p.url, attribution: `Pixabay / ${h.user || 'author'}`, tags: [], w: p.width, h: p.height };
    }
    return null;
  }

  // Public single-clip lookup (raw term, already resolved to EN by the caller if needed).
  // `pick` selects a non-first result — used by "Перегенерировать" so it doesn't just return the same clip.
  async findOne(term: string, orientation?: string, pick = 0): Promise<Clip | null> {
    const provider = this.provider();
    if (!provider) return null;
    return this.search(provider, term, orientation, pick);
  }
}
