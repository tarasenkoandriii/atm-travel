import { Injectable, Logger } from '@nestjs/common';
import { Camera } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CamerasRepository } from './cameras.repository';

export interface SnapshotPayload {
  builtAt: string;
  count: number;
  cameras: any[];
}

// Materialized catalog snapshot for fast client delivery (ТЗ §9/§14).
// On Vercel there is no persistent FS, so the snapshot lives in Postgres (SNAPSHOT_STORE=postgres).
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(private readonly prisma: PrismaService, private readonly repo: CamerasRepository) {}

  private toClient(c: Camera) {
    return {
      id: c.id, type: c.type.toLowerCase(), title: c.title, city: c.city, country: c.country,
      cc: c.cc, lat: c.lat, lng: c.lng, tz: c.tz, res: c.res,
      videoId: c.videoId, embed: c.embed, clipUrl: c.clipUrl, img: c.img,
      category: c.category, wcCategory: c.wcCategory, provider: c.provider,
      iata: c.iata, isLive: c.isLive,
    };
  }

  async rebuild(): Promise<SnapshotPayload> {
    const cams = await this.repo.findAllActive();
    const payload: SnapshotPayload = {
      builtAt: new Date().toISOString(),
      count: cams.length,
      cameras: cams.map((c) => this.toClient(c)),
    };
    await this.prisma.snapshot.upsert({
      where: { id: 'catalog' },
      create: { id: 'catalog', payload: payload as any },
      update: { payload: payload as any, builtAt: new Date() },
    });
    this.logger.log(`Snapshot rebuilt: ${cams.length} cameras`);
    return payload;
  }

  async get(): Promise<SnapshotPayload | null> {
    const row = await this.prisma.snapshot.findUnique({ where: { id: 'catalog' } });
    return (row?.payload as any as SnapshotPayload) ?? null;
  }
}
