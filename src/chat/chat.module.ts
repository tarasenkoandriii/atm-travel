import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SearchModule } from '../search/search.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

@Module({
  imports: [SearchModule, EmbeddingsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
