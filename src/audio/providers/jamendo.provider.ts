import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AudioProvider, AudioRequest, NormalizedAudioTrack } from '../audio.types';

/**
 * Jamendo catalog adapter — GET /v3.0/tracks.
 * Free tier is non-commercial only; commercial use needs a paid Jamendo quote (set
 * JAMENDO_HAS_COMMERCIAL=true once you hold one).
 */
@Injectable()
export class JamendoProvider implements AudioProvider {
  readonly id = 'jamendo' as const;
  readonly capabilities = ['search'] as const;
  private readonly base = 'https://api.jamendo.com/v3.0';

  constructor(private readonly config: ConfigService) {}

  private get clientId() { return this.config.get<string>('JAMENDO_CLIENT_ID') || ''; }
  private get hasCommercialLicense() { return this.config.get<string>('JAMENDO_HAS_COMMERCIAL') === 'true'; }
  get enabled() { return !!this.clientId; }

  async search(req: AudioRequest): Promise<NormalizedAudioTrack[]> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      format: 'json',
      audioformat: 'mp32',
      include: 'musicinfo licenses',
      limit: String(req.maxResults ?? 20),
    });
    if (req.query) params.set('search', req.query);
    if (req.genre?.length) params.set('tags', req.genre.join('+'));
    if (req.durationSec) {
      const pad = 15;
      params.set('durationbetween', `${Math.max(0, req.durationSec - pad)}_${req.durationSec + pad}`);
    }

    const res = await fetch(`${this.base}/tracks/?${params.toString()}`);
    if (!res.ok) throw new Error(`Jamendo ${res.status}`);
    const body = (await res.json()) as { results: JamendoTrack[] };
    return body.results.map((r) => this.normalize(r));
  }

  private normalize(r: JamendoTrack): NormalizedAudioTrack {
    const commercial = this.hasCommercialLicense;
    return {
      provider: this.id,
      providerTrackId: String(r.id),
      kind: 'music',
      title: r.name,
      artist: r.artist_name,
      durationSec: Number(r.duration) || 0,
      // Jamendo does not reliably expose BPM via the public API -> undefined; the client-side
      // beat detector fills the grid.
      bpm: undefined,
      mood: [],
      genre: r.musicinfo?.tags?.genres ?? [],
      tags: [
        ...(r.musicinfo?.tags?.vartags ?? []),
        ...(r.musicinfo?.tags?.instruments ?? []),
      ],
      previewUrl: r.audio,
      audioUrl: r.audiodownload || r.audio,
      license: {
        type: commercial ? 'jamendo-commercial' : 'jamendo-noncommercial',
        commercialUse: commercial,
        attributionRequired: false,
        requiresPaidLicense: !commercial,
        licenseUrl: r.license_ccurl,
      },
      raw: r,
    };
  }
}

interface JamendoTrack {
  id: number | string;
  name: string;
  artist_name: string;
  duration: number | string;
  audio: string;
  audiodownload: string;
  license_ccurl?: string;
  musicinfo?: {
    tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] };
  };
}
