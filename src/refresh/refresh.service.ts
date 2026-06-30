import { Injectable, Logger } from '@nestjs/common';
import { RefreshTrigger } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { YoutubeAdapter } from '../sources/adapters/youtube.adapter';
import { WindyAdapter } from '../sources/adapters/windy.adapter';
import { CamerasRepository } from '../cameras/cameras.repository';
import { SnapshotService } from '../cameras/snapshot.service';
import { LivenessService } from './liveness.service';

const LOCK_KEY = 778421; // arbitrary advisory-lock key for the refresh job

@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly youtube: YoutubeAdapter,
    private readonly windy: WindyAdapter,
    private readonly repo: CamerasRepository,
    private readonly liveness: LivenessService,
    private readonly snapshot: SnapshotService,
  ) {}

  async run(trigger: RefreshTrigger) {
    // Distributed overlap-guard (serverless-safe): skip if another run holds the lock.
    const acquired = await this.prisma.tryAdvisoryLock(LOCK_KEY);
    if (!acquired) {
      this.logger.warn('Refresh skipped — another run is in progress');
      return { skipped: true };
    }

    const t0 = Date.now();
    const run = await this.prisma.refreshRun.create({ data: { trigger } });
    try {
      // 1) discovery — YouTube only when its API key is configured (ТЗ §5)
      const [yt, wd] = await Promise.all([
        this.youtube.enabled ? this.youtube.discover() : Promise.resolve([]),
        this.windy.discover(),
      ]);
      if (!this.youtube.enabled) {
        const hidden = await this.repo.hideSource('YOUTUBE');
        if (hidden) this.logger.warn(`YouTube disabled — hid ${hidden} existing YouTube camera(s)`);
      }
      const discovered = [...yt, ...wd];
      const added = await this.repo.upsertMany(discovered);

      // 2) liveness
      const checkable = await this.repo.findCheckable();
      const { live, dead, checked } = await this.liveness.checkBatch(checkable);

      // 3) snapshot
      await this.snapshot.rebuild();

      await this.prisma.refreshRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(), durationMs: Date.now() - t0,
          addedCount: added, liveCount: live, deadCount: dead, totalChecked: checked,
          windyStatus: this.windy.lastStatus ?? undefined,
        },
      });
      this.logger.log(`Refresh done: +${added} added, ${live} live, ${dead} dead, ${checked} checked (${Date.now() - t0}ms)`);
      return { runId: run.id, added, live, dead, checked };
    } catch (e) {
      await this.prisma.refreshRun.update({
        where: { id: run.id },
        data: { finishedAt: new Date(), durationMs: Date.now() - t0, error: String(e) },
      });
      throw e;
    } finally {
      await this.prisma.advisoryUnlock(LOCK_KEY);
    }
  }

  recentRuns(limit = 20) {
    return this.prisma.refreshRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  }
  getRun(id: string) {
    return this.prisma.refreshRun.findUnique({ where: { id } });
  }
}
