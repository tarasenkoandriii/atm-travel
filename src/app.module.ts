import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { I18nModule } from './i18n/i18n.module';
import { CamerasModule } from './cameras/cameras.module';
import { SourcesModule } from './sources/sources.module';
import { WeatherModule } from './weather/weather.module';
import { TravelModule } from './travel/travel.module';
import { RefreshModule } from './refresh/refresh.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { HealthModule } from './health/health.module';
import { FrontendModule } from './frontend/frontend.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CommonModule,
    I18nModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]), // protect upstream quotas (ТЗ §12)
    CamerasModule,
    SourcesModule,
    WeatherModule,
    TravelModule,
    RefreshModule,
    BootstrapModule,
    HealthModule,
    FrontendModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
