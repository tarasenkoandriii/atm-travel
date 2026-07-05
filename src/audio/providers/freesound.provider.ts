import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AudioProvider,
  AudioRequest,
  NormalizedAudioTrack,
  normalizeCcLicense,
} from '../audio.types';

/**
 * Freesound catalog adapter (sfx / ambience, some music) — GET /apiv2/search/text.
 * Token auth for search + previews; HQ (non-preview) download is OAuth2-gated, hence
 * resolveDownloadUrl() (set FREESOUND_OAUTH_BEARER to use it).
 */
@Injectable()
export class FreesoundProvider implements AudioProvider {
  readonly id = 'freesound' as const;
  readonly capabilities = ['search'] as const;
  private readonly base = 'https://freesound.org/apiv2';

  constructor(private readonly config: ConfigService) {}

  private get token() { return this.config.get<string>('FREESOUND_TOKEN') || ''; }
  private get oauthBearer() { return this.config.get<string>('FREESOUND_OAUTH_BEARER') || ''; }
  get enabled() { return !!this.token; }

  async search(req: AudioRequest): Promise<NormalizedAudioTrack[]> {
    const filters: string[] = [];
    if (req.durationSec) {
      filters.push(`duration:[${Math.max(0, req.durationSec - 20)} TO ${req.durationSec + 20}]`);
    }
    if (req.bpmRange) {
      filters.push(`ac_tempo:[${req.bpmRange[0]} TO ${req.bpmRange[1]}]`);
    }
    const params = new URLSearchParams({
      query: req.query ?? req.mood?.join(' ') ?? '',
      fields: 'id,name,username,duration,previews,license,tags,ac_analysis',
      page_size: String(req.maxResults ?? 20),
      token: this.token,
    });
    if (filters.length) params.set('filter', filters.join(' '));

    const res = await fetch(`${this.base}/search/text/?${params.toString()}`);
    if (!res.ok) throw new Error(`Freesound ${res.status}`);
    const body = (await res.json()) as { results: FreesoundSound[] };
    return body.results.map((s) => this.normalize(s, req.kind));
  }

  async resolveDownloadUrl(t: NormalizedAudioTrack): Promise<string> {
    // Previews need only the token and are fine for montage; HQ original needs OAuth.
    if (!this.oauthBearer) return t.audioUrl;
    const res = await fetch(`${this.base}/sounds/${t.providerTrackId}/download/`, {
      headers: { Authorization: `Bearer ${this.oauthBearer}` },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Freesound download ${res.status}`);
    return res.url;
  }

  private normalize(s: FreesoundSound, kind: AudioRequest['kind']): NormalizedAudioTrack {
    const license = normalizeCcLicense(s.license);
    if (license.attributionRequired) {
      license.attributionText = `"${s.name}" by ${s.username} (${license.type})`;
    }
    return {
      provider: this.id,
      providerTrackId: String(s.id),
      kind: kind === 'music' ? 'music' : 'ambience',
      title: s.name,
      artist: s.username,
      durationSec: s.duration,
      bpm: s.ac_analysis?.ac_tempo,
      key: s.ac_analysis?.ac_tonality,
      mood: [],
      genre: [],
      tags: s.tags ?? [],
      previewUrl: s.previews?.['preview-hq-mp3'] ?? s.previews?.['preview-lq-mp3'],
      audioUrl: s.previews?.['preview-hq-mp3'] ?? '',
      license,
      raw: s,
    };
  }
}

interface FreesoundSound {
  id: number;
  name: string;
  username: string;
  duration: number;
  license: string;
  tags?: string[];
  previews?: Record<string, string>;
  ac_analysis?: { ac_tempo?: number; ac_tonality?: string };
}
