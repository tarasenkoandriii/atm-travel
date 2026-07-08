import { Module } from '@nestjs/common';
import { ReelController } from './reel.controller';
import { ReelClipsService } from './reel-clips.service';
import { AudioModule } from '../audio/audio.module';
import { HotToursModule } from '../hottours/hottours.module';

@Module({ imports: [AudioModule, HotToursModule], controllers: [ReelController], providers: [ReelClipsService], exports: [ReelClipsService] })
export class ReelModule {}
