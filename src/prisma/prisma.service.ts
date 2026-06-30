import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Distributed overlap-guard for serverless (Vercel): Postgres advisory lock.
   * Returns true if the lock was acquired (try-lock, non-blocking).
   */
  async tryAdvisoryLock(key: number): Promise<boolean> {
    const rows = await this.$queryRawUnsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_lock(${key}) AS locked`,
    );
    return rows?.[0]?.locked === true;
  }

  async advisoryUnlock(key: number): Promise<void> {
    await this.$queryRawUnsafe(`SELECT pg_advisory_unlock(${key})`);
  }
}
