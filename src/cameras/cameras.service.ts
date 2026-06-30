import { Injectable } from '@nestjs/common';
import { CamerasRepository } from './cameras.repository';
import { SnapshotService } from './snapshot.service';
import { QueryCamerasDto } from './dto/query-cameras.dto';
import { I18nService } from '../i18n/i18n.service';

const FIXED_CATS = [
  'auto-moto', 'nature', 'tourism', 'real-estate', 'people', 'architecture', 'museums', 'custom',
];

@Injectable()
export class CamerasService {
  constructor(
    private readonly repo: CamerasRepository,
    private readonly snapshot: SnapshotService,
    private readonly i18n: I18nService,
  ) {}

  async list(q: QueryCamerasDto) {
    const res = await this.repo.findPublic({
      category: q.category, cc: q.cc,
      isLive: q.isLive === undefined ? undefined : q.isLive === 'true',
      q: q.q, page: q.page, limit: q.limit,
    });
    const snap = await this.snapshot.get();
    return { ...res, page: q.page, limit: q.limit, lastRefreshAt: snap?.builtAt ?? null };
  }

  get(id: string) {
    return this.repo.findById(id);
  }

  async getSnapshot() {
    return (await this.snapshot.get()) ?? (await this.snapshot.rebuild());
  }

  async categories(locale: string) {
    const counts = await this.repo.categoryCounts();
    const labels = this.i18n.dictionary(locale).categories || {};
    return [{ slug: 'all', label: labels['all'] ?? 'All', count: Object.values(counts).reduce((a, b) => a + b, 0) }]
      .concat(
        FIXED_CATS.map((slug) => ({ slug, label: labels[slug] ?? slug, count: counts[slug] ?? 0 })),
      );
  }
}
