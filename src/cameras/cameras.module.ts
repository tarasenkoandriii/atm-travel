import { Module } from '@nestjs/common';
import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';
import { CamerasRepository } from './cameras.repository';
import { SnapshotService } from './snapshot.service';

@Module({
  controllers: [CamerasController],
  providers: [CamerasService, CamerasRepository, SnapshotService],
  exports: [CamerasService, CamerasRepository, SnapshotService],
})
export class CamerasModule {}
