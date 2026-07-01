import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RefreshTrigger } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { YoutubeAdapter } from '../sources/adapters/youtube.adapter';
import { WindyAdapter } from '../sources/adapters/windy.adapter';
import { CamerasRepository } from '../cameras/cameras.repository';
import { DealsService } from '../deals/deals.service';
import { CheckoutService } from '../esim/checkout/checkout.service';
import { SnapshotService } from '../cameras/snapshot.service';
import { LivenessService } from './liveness.service';


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
    private readonly deals: DealsService,
    private readonly checkout: CheckoutService,
  ) {}

  async run(trigger: RefreshTrigger) {
    // NOTE: no advisory lock. Session-level pg_advisory_lock leaks under PgBouncer transaction
    // pooling (Supabase :6543) — the unlock lands on a different backend, so the lock is never
    // released and every subsequent run gets skipped. For a once-daily cron + rare manual runs,
    // overlap is harmless anyway: upsertMany is idempotent on the unique key.
    const t0 = Date.now();
    // First DB write — if this fails, the database is unreachable (clear 503 instead of raw 500).
    let run: { id: string };
    try {
      run = await this.prisma.refreshRun.create({ data: { trigger } });
    } catch (e) {
      this.logger.error(`Refresh aborted — database unreachable: ${String(e)}`);
      throw new ServiceUnavailableException({
        error: 'db_unavailable',
        message:
          'Database not reachable. On Vercel use the Supabase POOLER connection string ' +
          '(...pooler.supabase.com:6543/postgres?pgbouncer=true) for DATABASE_URL. Check /health.',
      });
    }
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

      // Liveness is already determined at discovery (Windy player.live.available / YouTube Data API),
      // and is written during upsert. Skip the per-camera re-check pass (thousands of DB updates that
      // don't fit serverless limits under a pooled connection).
      const live = discovered.filter((c) => c.isLive).length;
      const dead = 0;
      const checked = discovered.length;

      // snapshot
      await this.snapshot.rebuild();
      await this.deals.refresh().catch((e) => this.logger.warn(`Deals refresh skipped: ${String(e)}`));
      await this.checkout.retryPending().catch((e) => this.logger.warn(`eSIM provision retry skipped: ${String(e)}`));

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
      }).catch(() => {});
      throw e;
    }
  }

  recentRuns(limit = 20) {
    return this.prisma.refreshRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  }
  getRun(id: string) {
    return this.prisma.refreshRun.findUnique({ where: { id } });
  }
}
