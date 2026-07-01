import { Injectable } from '@nestjs/common';
import { Camera, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoveredCamera } from '../sources/source.types';

@Injectable()
export class CamerasRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(cams: DiscoveredCamera[]): Promise<number> {
    if (!cams.length) return 0;
    const now = new Date();
    const data = cams.map((c) => ({
      source: c.source, externalId: c.externalId, type: c.type, provider: c.provider ?? null,
      title: c.title, city: c.city ?? null, country: c.country ?? null, cc: c.cc ?? null,
      lat: c.lat, lng: c.lng, tz: c.tz ?? 'UTC', res: c.res ?? 'HD',
      videoId: c.videoId ?? null, embed: c.embed ?? null, img: c.img ?? null,
      category: c.category ?? null, wcCategory: c.wcCategory ?? null, iata: c.iata ?? null,
      isLive: c.isLive ?? false,
      lastCheckedAt: now, lastLiveAt: c.isLive ? now : null,
      status: 'ACTIVE' as const,
    }));

    // Bulk insert new cameras in chunks (a few queries instead of one round-trip per camera —
    // critical under Supabase pooler with connection_limit=1). isLive is known at discovery.
    let added = 0;
    const CHUNK = 500;
    for (let i = 0; i < data.length; i += CHUNK) {
      const res = await this.prisma.camera.createMany({ data: data.slice(i, i + CHUNK), skipDuplicates: true });
      added += res.count;
    }

    // Reactivate any previously hidden/dead cameras that were re-discovered (single bulk query).
    const ids = cams.map((c) => c.externalId);
    await this.prisma.camera
      .updateMany({ where: { externalId: { in: ids }, status: { not: 'ACTIVE' } }, data: { status: 'ACTIVE' } })
      .catch(() => undefined);

    return added;
  }

  findCheckable(): Promise<Camera[]> {
    return this.prisma.camera.findMany({ where: { status: { not: 'HIDDEN' } } });
  }

  async findPublic(params: {
    category?: string; cc?: string; isLive?: boolean; q?: string;
    page: number; limit: number;
  }) {
    const where: Prisma.CameraWhereInput = { status: 'ACTIVE' };
    if (params.category && params.category !== 'all') {
      if (params.category.startsWith('wc:')) where.wcCategory = params.category.slice(3);
      else where.category = params.category;
    }
    if (params.cc) where.cc = params.cc;
    if (params.isLive !== undefined) where.isLive = params.isLive;
    if (params.q) {
      where.OR = [
        { title: { contains: params.q, mode: 'insensitive' } },
        { city: { contains: params.q, mode: 'insensitive' } },
        { country: { contains: params.q, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.camera.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { isLive: 'desc' }, { title: 'asc' }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.camera.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string) {
    return this.prisma.camera.findUnique({ where: { id } });
  }

  /** Hide all cameras of a given source (e.g. when YOUTUBE is disabled) so they leave the public catalog. */
  async hideSource(source: 'YOUTUBE' | 'WINDY'): Promise<number> {
    const res = await this.prisma.camera.updateMany({
      where: { source, status: { not: 'HIDDEN' } },
      data: { status: 'HIDDEN', isLive: false },
    });
    return res.count;
  }

  findAllActive(): Promise<Camera[]> {
    return this.prisma.camera.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { isLive: 'desc' }],
    });
  }

  async categoryCounts(): Promise<Record<string, number>> {
    const rows = await this.prisma.camera.groupBy({
      by: ['category'],
      where: { status: 'ACTIVE', isLive: true },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) if (r.category) out[r.category] = r._count._all;
    return out;
  }
}
