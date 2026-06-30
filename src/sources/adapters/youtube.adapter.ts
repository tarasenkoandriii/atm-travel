import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CameraSourceAdapter, DiscoveredCamera } from '../source.types';
import { YOUTUBE_SEED } from './youtube.seed';
import { chunk } from '../../common/util/concurrency';

@Injectable()
export class YoutubeAdapter implements CameraSourceAdapter {
  readonly source = 'YOUTUBE' as const;
  private readonly logger = new Logger(YoutubeAdapter.name);
  private liveSet: Set<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** YouTube source is used only when a Data API key is configured. */
  get enabled(): boolean {
    return !!this.config.get<string>('YOUTUBE_API_KEY');
  }

  async discover(): Promise<DiscoveredCamera[]> {
    const key = this.config.get<string>('YOUTUBE_API_KEY');
    if (!key) {
      // No key -> YouTube source is disabled entirely (no seed cameras, no validation).
      this.liveSet = null;
      this.logger.warn('YOUTUBE_API_KEY not set — YouTube source disabled (seed skipped)');
      return [];
    }
    // Curated seed; refresh liveness in bulk to avoid per-camera quota cost.
    this.liveSet = await this.fetchLiveSet(YOUTUBE_SEED.map((c) => c.videoId!).filter(Boolean), key);
    return YOUTUBE_SEED.map((c) => ({ ...c, isLive: this.liveSet ? this.liveSet.has(c.videoId!) : false }));
  }

  async isLive(cam: { videoId?: string | null; isLive?: boolean }): Promise<boolean> {
    if (!this.enabled) return false; // disabled -> never live
    if (!cam.videoId) return false;
    if (this.liveSet) return this.liveSet.has(cam.videoId);
    return cam.isLive ?? false;
  }

  /** Batch videos.list (<=50 ids) -> set of currently-live videoIds. */
  private async fetchLiveSet(ids: string[], key: string): Promise<Set<string>> {
    const live = new Set<string>();
    for (const batch of chunk(ids, 50)) {
      const url =
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails` +
        `&id=${batch.join(',')}&key=${key}`;
      try {
        const r = await fetch(url);
        if (!r.ok) { this.logger.warn(`YT Data API HTTP ${r.status}`); continue; }
        const j: any = await r.json();
        for (const item of j.items || []) {
          const isLive = item?.snippet?.liveBroadcastContent === 'live';
          const ended = !!item?.liveStreamingDetails?.actualEndTime;
          if (isLive && !ended) live.add(item.id);
        }
      } catch (e) {
        this.logger.warn(`YT Data API error: ${String(e)}`);
      }
    }
    return live;
  }
}
