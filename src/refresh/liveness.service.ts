import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Camera } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { YoutubeAdapter } from '../sources/adapters/youtube.adapter';
import { WindyAdapter } from '../sources/adapters/windy.adapter';
import { pMap } from '../common/util/concurrency';

@Injectable()
export class LivenessService {
  private readonly logger = new Logger(LivenessService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly youtube: YoutubeAdapter,
    private readonly windy: WindyAdapter,
  ) {}

  async checkBatch(cameras: Camera[]): Promise<{ live: number; dead: number; checked: number }> {
    const concurrency = this.config.get<number>('LIVENESS_CONCURRENCY')!;
    const deadThreshold = this.config.get<number>('DEAD_THRESHOLD')!;
    let live = 0, dead = 0, checked = 0;

    await pMap(cameras, async (cam) => {
      checked++;
      let isLive = false;
      try {
        isLive = cam.source === 'YOUTUBE'
          ? await this.youtube.isLive({ videoId: cam.videoId, isLive: cam.isLive })
          : await this.windy.isLive({ embed: cam.embed, isLive: cam.isLive });
      } catch (e) {
        this.logger.warn(`liveness error ${cam.id}: ${String(e)}`);
      }

      if (isLive) {
        live++;
        await this.prisma.camera.update({
          where: { id: cam.id },
          data: { isLive: true, lastLiveAt: new Date(), lastCheckedAt: new Date(), failCount: 0, status: 'ACTIVE' },
        });
      } else {
        const failCount = cam.failCount + 1;
        const status = failCount >= deadThreshold ? 'DEAD' : cam.status;
        if (status === 'DEAD') dead++;
        await this.prisma.camera.update({
          where: { id: cam.id },
          data: { isLive: false, lastCheckedAt: new Date(), failCount, status },
        });
      }
    }, concurrency);

    return { live, dead, checked };
  }
}
