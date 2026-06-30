import { PrismaClient } from '@prisma/client';
import { YOUTUBE_SEED } from '../src/sources/adapters/youtube.seed';

const prisma = new PrismaClient();

async function main() {
  for (const c of YOUTUBE_SEED) {
    await prisma.camera.upsert({
      where: { source_externalId: { source: c.source, externalId: c.externalId } },
      create: {
        source: c.source, externalId: c.externalId, type: c.type, provider: c.provider,
        title: c.title, city: c.city, country: c.country, cc: c.cc, lat: c.lat, lng: c.lng,
        tz: c.tz ?? 'UTC', res: c.res ?? 'HD', videoId: c.videoId ?? null,
        category: c.category ?? null, wcCategory: c.wcCategory ?? null, iata: c.iata ?? null,
        isLive: true, status: 'ACTIVE',
      },
      update: {},
    });
  }
  console.log(`Seeded ${YOUTUBE_SEED.length} YouTube cameras`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
