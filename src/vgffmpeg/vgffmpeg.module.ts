import { Module } from '@nestjs/common';
import { VgFfmpegController } from './vgffmpeg.controller';
import { VgFfmpegService } from './vgffmpeg.service';

@Module({ controllers: [VgFfmpegController], providers: [VgFfmpegService], exports: [VgFfmpegService] })
export class VgFfmpegModule {}
