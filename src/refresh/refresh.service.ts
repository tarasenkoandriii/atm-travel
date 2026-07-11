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
import { HotToursService } from '../hottours/hottours.service';
import { PublishJobsService } from '../publish/publish-jobs.service';
import { SearchService } from '../search/search.service';
import { EmbeddingService } from '../embeddings/embeddings.service';
import { ChatService } from '../chat/chat.service';
import { BlogService } from '../blog/blog.service';


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
    private readonly hotTours: HotToursService,
    private readonly publishJobs: PublishJobsService,
    private readonly search: SearchService,
    private readonly embeddings: EmbeddingService,
    private readonly chat: ChatService,
    private readonly blog: BlogService,
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
      // Prune short-lived clip selections older than 2 days.
      await this.prisma.clipSet
        .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * 86400 * 1000) } } })
        .catch((e) => this.logger.warn(`ClipSet prune skipped: ${String(e)}`));

      // Hot-tours: ingest feeds → expire stale → generate up to N articles → sitemaps.
      // Isolated so a feed/Grok hiccup never fails the main camera refresh.
      try {
        const ht = await this.hotTours.runCron();
        this.logger.log(`hot-tours: providers=${ht.providers} ingested=${ht.ingested} expired=${ht.expired} generated=${ht.generated}`);
      } catch (e) { this.logger.warn(`hot-tours cron skipped: ${String(e)}`); }

      // Daily "top-3 deals" digest → public Telegram group (marketing/promo, not the admin channel).
      try {
        const dd = await this.hotTours.sendTopDealsDigest();
        if (dd.sent) this.logger.log(`top-deals digest: sent (${dd.count} tours)`);
      } catch (e) { this.logger.warn(`top-deals digest skipped: ${String(e)}`); }

      // Publish queue: nudge pending IG/YouTube jobs forward and fail ones stuck too long.
      try {
        const stuck = await this.publishJobs.cleanupStuck(60);
        const advanced = await this.publishJobs.processPending(10, 6);
        if (stuck || advanced) this.logger.log(`publish-jobs: advanced=${advanced} stuck-cleared=${stuck}`);
      } catch (e) { this.logger.warn(`publish-jobs cron skipped: ${String(e)}`); }

      // Notify saved-search subscribers about new matching tours.
      try { const n = await this.search.notify(); if (n.sent) this.logger.log(`search-notify: checked=${n.checked} sent=${n.sent}`); }
      catch (e) { this.logger.warn(`search-notify skipped: ${String(e)}`); }
      // Daily digest for frequency=daily subscriptions (daily cron = once a day).
      try { const d = await this.search.digest(); if (d.sent) this.logger.log(`search-digest: checked=${d.checked} sent=${d.sent}`); }
      catch (e) { this.logger.warn(`search-digest skipped: ${String(e)}`); }

      // ОРБИТА-Гид fallback (real drivers are hourly pg_cron): re-embed changed tours + dispatch due reminders.
      try { const em = await this.embeddings.embedChanged(); if (em.embedded) this.logger.log(`embed: cand=${em.candidates} done=${em.embedded} fail=${em.failed}`); }
      catch (e) { this.logger.warn(`embed skipped: ${String(e)}`); }
      try { const rm = await this.chat.dispatchReminders(); if (rm.sent) this.logger.log(`reminders: due=${rm.due} sent=${rm.sent}`); }
      catch (e) { this.logger.warn(`reminders skipped: ${String(e)}`); }

      // Blog: one original travel article per daily run (guides/tips/reviews/stories).
      try { const made = await this.blog.generateOne(); if (made) this.logger.log('blog: +1 article (draft)'); }
      catch (e) { this.logger.warn(`blog gen skipped: ${String(e)}`); }
      // Weekly-idempotent subscriber-state snapshot (active/paused/canceled) for the retention triangle.
      try { const sn = await this.hotTours.snapshotSubscribers(); if (sn.subs) this.logger.log(`subscriber-snapshot: ${sn.subs}`); }
      catch (e) { this.logger.warn(`subscriber-snapshot skipped: ${String(e)}`); }

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
