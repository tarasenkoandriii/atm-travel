import { Module } from '@nestjs/common';
import { YoutubeAdapter } from './adapters/youtube.adapter';
import { WindyAdapter } from './adapters/windy.adapter';

@Module({
  providers: [YoutubeAdapter, WindyAdapter],
  exports: [YoutubeAdapter, WindyAdapter],
})
export class SourcesModule {}
