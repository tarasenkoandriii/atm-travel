import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RefreshController } from './refresh.controller';
import { RefreshService } from './refresh.service';
import { RefreshScheduler } from './refresh.scheduler';
import { LivenessService } from './liveness.service';
import { SourcesModule } from '../sources/sources.module';
import { CamerasModule } from '../cameras/cameras.module';

@Module({
  imports: [ScheduleModule.forRoot(), SourcesModule, CamerasModule],
  controllers: [RefreshController],
  providers: [RefreshService, RefreshScheduler, LivenessService],
  exports: [RefreshService],
})
export class RefreshModule {}
