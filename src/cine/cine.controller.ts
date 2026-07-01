import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cinematic route storage endpoints. Rendering happens in the browser (canvas + MediaRecorder);
 * these routes issue a client-upload token for Vercel Blob and persist the resulting set so the
 * three format URLs can be fetched later via GET /api/cine/:id.
 */
@Controller('api/cine')
export class CineController {
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private get blobEnabled() { return !!this.config.get<string>('BLOB_READ_WRITE_TOKEN'); }

  @Get('config')
  cfg() { return { blobEnabled: this.blobEnabled }; }

  // Vercel Blob client-upload: validates and returns an upload token to the browser SDK.
  @Post('blob-token')
  async blobToken(@Body() body: any, @Req() req: Request) {
    const { handleUpload } = await import('@vercel/blob/client');
    return handleUpload({
      body,
      request: req as any,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/webm', 'video/mp4'],
        addRandomSuffix: true,
        maximumSizeInBytes: 200 * 1024 * 1024,
      }),
      onUploadCompleted: async () => { /* optional: could log here */ },
    });
  }

  @Post()
  async create(
    @Body() body: { lat: number; lng: number; dur?: number; title?: string; items: { format: string; url: string }[] },
  ) {
    const row = await this.prisma.cineRender.create({
      data: {
        lat: Number(body.lat),
        lng: Number(body.lng),
        durationSec: Number(body.dur || 7),
        title: body.title || null,
        items: (body.items || []) as any,
      },
    });
    return { id: row.id };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const row = await this.prisma.cineRender.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('render not found');
    return {
      id: row.id, lat: row.lat, lng: row.lng, durationSec: row.durationSec,
      title: row.title, items: row.items, createdAt: row.createdAt,
    };
  }
}
