import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AudioProvider, AudioRequest, NormalizedAudioTrack, bpmCenter } from '../audio.types';

/**
 * Mubert generator adapter. No catalog: POST mood/tags/duration/bpm, get a rendered track.
 * Royalty-free commercial license by default. Endpoints rotate — verify against the current
 * B2B contract; override the base with MUBERT_BASE if it changes.
 */
@Injectable()
export class MubertProvider implements AudioProvider {
  readonly id = 'mubert' as const;
  readonly capabilities = ['generate'] as const;

  constructor(private readonly config: ConfigService) {}

  private get apiKey() { return this.config.get<string>('MUBERT_API_KEY') || ''; }
  private get base() {
    return (this.config.get<string>('MUBERT_BASE') || 'https://api-b2b.mubert.com/v2').replace(/\/$/, '');
  }
  get enabled() { return !!this.apiKey; }

  async generate(req: AudioRequest): Promise<NormalizedAudioTrack> {
    const duration = req.durationSec ?? 30;
    const bpm = bpmCenter(req.bpmRange);
    const promptTags = [...(req.mood ?? []), ...(req.genre ?? []), req.query]
      .filter(Boolean)
      .join(', ');

    // Skeleton POST — align field names with the current Mubert B2B contract.
    const res = await fetch(`${this.base}/RecordTrackTTM`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'RecordTrackTTM',
        params: {
          pat: this.apiKey,
          duration,
          bitrate: 320,
          intensity: 'medium',
          text: promptTags || 'travel, uplifting',
          ...(bpm ? { bpm } : {}),
        },
      }),
    });
    if (!res.ok) throw new Error(`Mubert ${res.status}`);
    const body = (await res.json()) as MubertResponse;

    // Real API is async: you may need to poll body.data.download_link until ready.
    const url = body?.data?.download_link;
    if (!url) throw new Error('Mubert: no download_link (track still rendering?)');

    return {
      provider: this.id,
      providerTrackId: body.data.id ?? `mubert-${Date.now()}`,
      kind: 'generative',
      title: promptTags || 'Generated track',
      durationSec: duration,
      bpm,
      mood: req.mood ?? [],
      genre: req.genre ?? [],
      tags: [],
      audioUrl: url,
      license: {
        type: 'mubert-royalty-free',
        commercialUse: true,
        attributionRequired: false,
        requiresPaidLicense: false, // covered by your Mubert plan
      },
      raw: body,
    };
  }
}

interface MubertResponse {
  data: { id?: string; download_link?: string };
}
