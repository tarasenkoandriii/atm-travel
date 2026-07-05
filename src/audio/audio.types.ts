/**
 * Framework-agnostic core of the audio-source abstraction for ОРБИТА / reel pipeline.
 *
 * Mirrors the EsimProvider pattern: one interface, several concrete adapters (in ./providers),
 * a DI token that collects them (AUDIO_PROVIDERS), and a declarative resolver a manifest drives.
 * Nest wiring lives in audio.module.ts — nothing here imports @nestjs/*.
 *
 * CAPABILITY MODEL:
 *   - Jamendo / Freesound are CATALOGS  -> capability 'search'
 *   - Mubert is a GENERATOR             -> capability 'generate'
 * The manifest states INTENT (AudioRequest); resolveAudio() picks the strategy per provider.
 *
 * Everything normalizes to NormalizedAudioTrack (license -> commercial/attribution filtering,
 * bpm -> beat-grid cut timing, nullable so client-side beat detection can fill the gap).
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type AudioProviderId = 'jamendo' | 'freesound' | 'mubert';
export type AudioCapability = 'search' | 'generate';
export type AudioKind = 'music' | 'sfx' | 'ambience' | 'generative';

export interface AudioLicense {
  /** Provider-specific label, e.g. 'CC-BY-4.0', 'jamendo-commercial', 'mubert-rf'. */
  type: string;
  commercialUse: boolean;
  attributionRequired: boolean;
  /** Pre-built credit line, present only when attributionRequired. */
  attributionText?: string;
  licenseUrl?: string;
  /**
   * True when the free API tier does NOT cover commercial use and a paid license/quote is
   * required before shipping (Jamendo commercial case). The resolver surfaces this so the
   * pipeline can flag or skip the track.
   */
  requiresPaidLicense?: boolean;
}

export interface NormalizedAudioTrack {
  provider: AudioProviderId;
  providerTrackId: string;
  kind: AudioKind;
  title: string;
  artist?: string;
  durationSec: number;
  /** Beats per minute. Undefined when the source doesn't expose it. */
  bpm?: number;
  /** Musical key if the provider reports it (Freesound AudioCommons). */
  key?: string;
  mood: string[];
  genre: string[];
  tags: string[];
  /** Low-quality streamable preview (no auth / token only). */
  previewUrl?: string;
  /** Playable/downloadable URL. May need resolveDownloadUrl() first. */
  audioUrl: string;
  waveformUrl?: string;
  license: AudioLicense;
  /** Original provider payload, kept for debugging / re-normalization. */
  raw?: unknown;
}

/**
 * Declarative, provider-agnostic intent. This is what lives in the manifest.
 * The resolver translates it into a catalog search OR generation params.
 */
export interface AudioRequest {
  kind: Exclude<AudioKind, 'generative'>; // manifest asks for music/sfx/ambience
  /** Free-text hint, e.g. 'uplifting travel', 'ocean waves at night'. */
  query?: string;
  mood?: string[];
  genre?: string[];
  /** Inclusive [min, max] tempo window; used for filtering + generation. */
  bpmRange?: [number, number];
  /** Target length. Generators honor it exactly; catalogs trim/loop later. */
  durationSec?: number;
  /** ОРБИТА default = true. Filters out non-commercial licenses. */
  commercialUseRequired?: boolean;
  /** When false, attribution-required tracks are filtered out. */
  allowAttribution?: boolean;
  /** When false, tracks needing a paid license are excluded outright. */
  allowPaidLicense?: boolean;
  maxResults?: number;
}

/** What resolveAudio() returns: the chosen track + resolution metadata. */
export interface AudioResolution {
  track: NormalizedAudioTrack;
  provider: AudioProviderId;
  /** Non-empty when the track requires a visible credit in the render. */
  attributionCredit?: string;
  /** True when a commercial license must still be purchased before shipping. */
  requiresPaidLicense: boolean;
}

// ---------------------------------------------------------------------------
// The interface every adapter implements
// ---------------------------------------------------------------------------

export interface AudioProvider {
  readonly id: AudioProviderId;
  readonly capabilities: readonly AudioCapability[];
  /** True when the provider has the credentials it needs (read from env by the adapter). */
  readonly enabled: boolean;

  /** Catalog search. Implement when capabilities includes 'search'. */
  search?(req: AudioRequest): Promise<NormalizedAudioTrack[]>;

  /** On-demand generation. Implement when capabilities includes 'generate'. */
  generate?(req: AudioRequest): Promise<NormalizedAudioTrack>;

  /** Fetch a single track by id (re-resolving a manifest that pinned an id). */
  getTrack?(providerTrackId: string): Promise<NormalizedAudioTrack>;

  /**
   * Some providers hand back only a preview; the real downloadable file needs a second call
   * (Freesound HQ download is OAuth-gated). Default impl can just return track.audioUrl.
   */
  resolveDownloadUrl?(track: NormalizedAudioTrack): Promise<string>;
}

// ---------------------------------------------------------------------------
// Shared normalization / scoring helpers
// ---------------------------------------------------------------------------

/** Maps a Creative Commons license URL to a normalized AudioLicense. */
export function normalizeCcLicense(licenseUrl: string): AudioLicense {
  const url = (licenseUrl || '').toLowerCase();
  let type = 'unknown';
  if (url.includes('publicdomain') || url.includes('zero')) type = 'CC0-1.0';
  else if (url.includes('by-nc')) type = 'CC-BY-NC';
  else if (url.includes('by-sa')) type = 'CC-BY-SA-4.0';
  else if (url.includes('/by/')) type = 'CC-BY-4.0';

  const commercialUse = !type.includes('NC') && type !== 'unknown';
  const attributionRequired = type !== 'CC0-1.0' && commercialUse;
  return { type, commercialUse, attributionRequired, licenseUrl };
}

/** Center of a bpm window, or undefined. Used for generation + scoring. */
export function bpmCenter(range?: [number, number]): number | undefined {
  return range ? Math.round((range[0] + range[1]) / 2) : undefined;
}

/** Hard filter: does this track satisfy the request's licensing + tempo? */
export function trackPassesFilter(t: NormalizedAudioTrack, req: AudioRequest): boolean {
  if (req.commercialUseRequired !== false && !t.license.commercialUse) return false;
  if (req.allowAttribution === false && t.license.attributionRequired) return false;
  if (req.allowPaidLicense === false && t.license.requiresPaidLicense) return false;
  if (req.bpmRange && t.bpm != null) {
    const [lo, hi] = req.bpmRange;
    if (t.bpm < lo || t.bpm > hi) return false;
  }
  return true;
}

/** Soft ranking: higher is better. Rewards tag overlap + bpm proximity. */
export function scoreTrack(t: NormalizedAudioTrack, req: AudioRequest): number {
  let score = 0;
  const wanted = new Set([...(req.mood ?? []), ...(req.genre ?? [])].map((s) => s.toLowerCase()));
  const have = new Set([...t.mood, ...t.genre, ...t.tags].map((s) => s.toLowerCase()));
  for (const w of wanted) if (have.has(w)) score += 2;

  const center = bpmCenter(req.bpmRange);
  if (center != null && t.bpm != null) score += Math.max(0, 5 - Math.abs(t.bpm - center) / 5);
  if (req.durationSec != null) score += Math.max(0, 3 - Math.abs(t.durationSec - req.durationSec) / 10);
  return score;
}

/** Build the visible credit line for a track that requires attribution. */
export function buildAttribution(t: NormalizedAudioTrack): string | undefined {
  if (!t.license.attributionRequired) return undefined;
  if (t.license.attributionText) return t.license.attributionText;
  const who = t.artist ? `${t.title} by ${t.artist}` : t.title;
  return `${who} (${t.license.type}) via ${t.provider}`;
}

// ---------------------------------------------------------------------------
// Resolver (the part the manifest drives) — takes the injected provider array
// ---------------------------------------------------------------------------

/**
 * Turns a declarative AudioRequest into a concrete track:
 *   - 'search' providers   -> query, hard-filter, then rank
 *   - 'generate' providers -> synthesize to spec (inherently satisfies filters)
 * Returns the first provider (in `prefer` order, else array order) that yields a passing track.
 */
export async function resolveAudio(
  req: AudioRequest,
  providers: AudioProvider[],
  prefer?: AudioProviderId[],
): Promise<AudioResolution> {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const order = prefer ?? providers.map((p) => p.id);

  for (const id of order) {
    const provider = byId.get(id);
    if (!provider) continue;
    try {
      let chosen: NormalizedAudioTrack | undefined;

      if (provider.capabilities.includes('search') && provider.search) {
        const results = await provider.search(req);
        chosen = results
          .filter((t) => trackPassesFilter(t, req))
          .sort((a, b) => scoreTrack(b, req) - scoreTrack(a, req))[0];
      } else if (provider.capabilities.includes('generate') && provider.generate) {
        const t = await provider.generate(req);
        if (trackPassesFilter(t, req)) chosen = t;
      }

      if (!chosen) continue;

      if (provider.resolveDownloadUrl) {
        chosen = { ...chosen, audioUrl: await provider.resolveDownloadUrl(chosen) };
      }

      return {
        track: chosen,
        provider: provider.id,
        attributionCredit: buildAttribution(chosen),
        requiresPaidLicense: chosen.license.requiresPaidLicense === true,
      };
    } catch {
      // Provider failed (rate limit, outage) -> try the next preference.
      continue;
    }
  }

  throw new Error('resolveAudio: no provider satisfied the request');
}

// ---------------------------------------------------------------------------
// Manifest schema — how a reel declares its soundtrack
// ---------------------------------------------------------------------------

export interface ReelAudioManifest {
  /** Ordered provider preference; omit to try all registered. */
  prefer?: AudioProviderId[];
  request: AudioRequest;
  /** Optional hard pin: skip resolution and reuse an exact track. */
  pinned?: { provider: AudioProviderId; providerTrackId: string };
}
