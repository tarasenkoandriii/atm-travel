import { Module } from '@nestjs/common';
import { BootstrapController } from './bootstrap.controller';
import { CamerasModule } from '../cameras/cameras.module';

@Module({
  imports: [CamerasModule],
  controllers: [BootstrapController],
})
export class BootstrapModule {}
