import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUDIO_PROVIDERS } from './audio.constants';
import {
  AudioProvider,
  AudioProviderId,
  AudioRequest,
  AudioResolution,
  buildAttribution,
  NormalizedAudioTrack,
  ReelAudioManifest,
  resolveAudio,
  scoreTrack,
  trackPassesFilter,
} from './audio.types';

/**
 * Provider-agnostic audio domain service.
 *
 * All concrete providers are injected via the AUDIO_PROVIDERS multi-token. Adding a provider is
 * pure configuration: register it under the same token in AudioModule and it becomes available
 * here with zero changes to this class or any caller.
 */
@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  constructor(@Inject(AUDIO_PROVIDERS) private readonly providers: AudioProvider[]) {}

  /** Providers that actually have credentials configured. */
  get available(): AudioProvider[] {
    return this.providers.filter((p) => p.enabled);
  }

  get enabled(): boolean {
    return this.available.length > 0;
  }

  /** Resolve a declarative manifest (honors a hard `pinned` track when the provider supports it). */
  async resolve(manifest: ReelAudioManifest): Promise<AudioResolution> {
    if (!this.enabled) throw new Error('No audio provider is configured');

    if (manifest.pinned) {
      const p = this.available.find((x) => x.id === manifest.pinned!.provider);
      if (p?.getTrack) {
        const track = await p.getTrack(manifest.pinned.providerTrackId);
        return {
          track,
          provider: p.id,
          attributionCredit: buildAttribution(track),
          requiresPaidLicense: track.license.requiresPaidLicense === true,
        };
      }
      this.logger.warn(`pinned track ignored: ${manifest.pinned.provider} has no getTrack()`);
    }

    return resolveAudio(manifest.request, this.available, manifest.prefer);
  }

  /** Resolve a bare request (no manifest wrapper). */
  resolveRequest(req: AudioRequest, prefer?: AudioProviderId[]): Promise<AudioResolution> {
    if (!this.enabled) return Promise.reject(new Error('No audio provider is configured'));
    return resolveAudio(req, this.available, prefer);
  }

  /**
   * Return several candidate tracks (filtered + ranked) so a UI can present variants to pick from.
   * Search providers contribute their matches; generators contribute a single synthesized track.
   */
  async candidates(req: AudioRequest, prefer?: AudioProviderId[], limit = 8): Promise<NormalizedAudioTrack[]> {
    const provs = this.available;
    const order = prefer ?? provs.map((p) => p.id);
    const out: NormalizedAudioTrack[] = [];
    for (const id of order) {
      const p = provs.find((x) => x.id === id);
      if (!p) continue;
      try {
        if (p.capabilities.includes('search') && p.search) {
          const r = await p.search(req);
          out.push(...r.filter((t) => trackPassesFilter(t, req)));
        } else if (p.capabilities.includes('generate') && p.generate) {
          const t = await p.generate(req);
          if (trackPassesFilter(t, req)) out.push(t);
        }
      } catch {
        // provider outage / rate limit — skip it
      }
      if (out.length >= limit * 2) break;
    }
    return out.sort((a, b) => scoreTrack(b, req) - scoreTrack(a, req)).slice(0, limit);
  }
}
