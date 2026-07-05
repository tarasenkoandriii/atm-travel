import { Module } from '@nestjs/common';
import { ReelController } from './reel.controller';
import { AudioModule } from '../audio/audio.module';

@Module({ imports: [AudioModule], controllers: [ReelController] })
export class ReelModule {}
