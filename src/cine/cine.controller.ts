import { BadRequestException, Body, Controller, Get, InternalServerErrorException, NotFoundException, Param, PayloadTooLargeException, Post, Query, Req } from '@nestjs/common';
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

  // Server-side upload: browser POSTs the finished video here (same-origin, no browser→blob CORS),
  // and we push it to Blob with put(). Body is capped at Vercel's ~4.5MB request limit.
  @Post('put')
  async put(@Req() req: Request, @Query('name') name: string, @Query('ct') ct: string) {
    if (!this.blobEnabled) throw new BadRequestException('blob not configured (no BLOB_READ_WRITE_TOKEN)');
    const body: any = (req as any).body;
    if (!body || !Buffer.isBuffer(body) || !body.length) {
      throw new BadRequestException('empty or non-buffer body (raw parser not applied?) type=' + typeof body);
    }
    if (body.length > 4.4 * 1024 * 1024) throw new PayloadTooLargeException('file exceeds 4.4MB server-upload limit');
    try {
      const { put } = await import('@vercel/blob');
      const safe = (name || 'cine/' + Date.now() + '.mp4').replace(/[^a-zA-Z0-9._/-]/g, '_');
      const res = await put(safe, body, { access: 'public', contentType: ct || 'video/mp4', addRandomSuffix: true });
      return { url: res.url };
    } catch (e: any) {
      // Surface the real cause (token/store/network) instead of a generic 500.
      throw new InternalServerErrorException('blob put failed: ' + String(e?.message || e));
    }
  }

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
