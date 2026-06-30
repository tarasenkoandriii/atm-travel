import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CameraSourceAdapter, DiscoveredCamera } from '../source.types';

@Injectable()
export class WindyAdapter implements CameraSourceAdapter {
  readonly source = 'WINDY' as const;
  private readonly logger = new Logger(WindyAdapter.name);
  lastStatus: number | null = null;

  constructor(private readonly config: ConfigService) {}

  // Maps Windy categories to internal slugs (ported mapWindyCat from pre-MVP).
  private mapCat(cats: any[]): string {
    const ids = (cats || []).map((c) => String((c && (c.id || c.name)) || '').toLowerCase());
    const has = (k: string) => ids.some((x) => x.indexOf(k) >= 0);
    if (has('traffic')) return 'auto-moto';
    if (['beach', 'mountain', 'park', 'lake', 'river', 'nature', 'meteo', 'snow'].some((k) => has(k))) return 'nature';
    if (['building', 'harbor', 'harbour'].some((k) => has(k))) return 'real-estate';
    return 'tourism';
  }

  async discover(): Promise<DiscoveredCamera[]> {
    const key = this.config.get<string>('WINDY_API_KEY');
    if (!key) {
      this.logger.warn('WINDY_API_KEY not set — skipping Windy discovery');
      return [];
    }
    const target = this.config.get<number>('WINDY_TARGET')!; // free-tier offset cap = 1000
    const per = 50;
    let off = 0;
    let useInclude = true;
    const out: DiscoveredCamera[] = [];

    const page = async (): Promise<any | null> => {
      let url = `https://api.windy.com/webcams/api/v3/webcams?limit=${per}&offset=${off}`;
      if (useInclude) url += '&include=location,player,categories,images';
      const r = await fetch(url, { headers: { 'x-windy-api-key': key } });
      this.lastStatus = r.status;
      return r.ok ? r.json() : null;
    };

    try {
      while (out.length < target && off < 1000) {
        let j = await page();
        if (j === null && useInclude && off === 0) { useInclude = false; j = await page(); } // retry without include
        if (j === null) { this.logger.warn(`Windy HTTP ${this.lastStatus}`); break; }
        const root = (j && (j.data || j.result)) || j || {};
        const cams: any[] = Array.isArray(root) ? root : root.webcams || j.webcams || [];
        if (!cams.length) break;

        for (const w of cams) {
          const loc = w.location || {};
          const lat = loc.latitude != null ? loc.latitude : loc.lat;
          const lng = loc.longitude != null ? loc.longitude : (loc.lon != null ? loc.lon : loc.lng);
          if (lat == null || lng == null) continue;
          const live = w.player?.live, day = w.player?.day, life = w.player?.lifetime;
          const embed = live?.available && live?.embed ? live.embed : day?.embed || life?.embed || '';
          const cur = w.images?.current;
          const img = cur ? cur.preview || cur.thumbnail || cur.icon || '' : '';
          out.push({
            source: 'WINDY',
            externalId: 'wc' + (w.webcamId || w.id),
            type: embed ? 'IFRAME' : 'IMAGE',
            provider: 'windy',
            title: w.title || loc.city || 'Webcam',
            city: loc.city || '',
            country: loc.country || '',
            cc: loc.country_code || '',
            lat, lng,
            tz: loc.timezone || 'UTC',
            res: 'HD',
            embed: embed || null,
            img: img || null,
            category: this.mapCat(w.categories),
            isLive: !!(live?.available),
          });
        }
        off += per;
      }
      this.logger.log(`Windy discovered ${out.length} cameras (status ${this.lastStatus})`);
    } catch (e) {
      this.logger.warn(`Windy error/CORS: ${String(e)}`);
    }
    return out;
  }

  async isLive(cam: { embed?: string | null; isLive?: boolean }): Promise<boolean> {
    // Windy liveness is known at discovery: live player available or an image snapshot present.
    return cam.isLive ?? !!cam.embed;
  }
}
