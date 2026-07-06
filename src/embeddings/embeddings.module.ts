import { Module } from '@nestjs/common';
import { EmbeddingsController } from './embeddings.controller';
import { EmbeddingService } from './embeddings.service';

@Module({
  controllers: [EmbeddingsController],
  providers: [EmbeddingService],
  exports: [EmbeddingService],
})
export class EmbeddingsModule {}
