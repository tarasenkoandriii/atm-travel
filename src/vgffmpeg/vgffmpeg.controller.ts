import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VgFfmpegService, VgManifest } from './vgffmpeg.service';

/**
 * Admin-gated proxy in front of the real, hosted Very Good FFmpeg API (verygoodffmpeg.com).
 * The API key stays server-side; the browser only ever talks to these two routes.
 */
@Controller('api/vgffmpeg')
export class VgFfmpegController {
  constructor(private readonly config: ConfigService, private readonly svc: VgFfmpegService) {}

  private adminOk(key?: string): boolean {
    const admin = this.config.get<string>('HOT_TOURS_ADMIN_TOKEN');
    return !!admin && key === admin;
  }

  @Get('config')
  cfg(@Query('key') key?: string) {
    if (!this.adminOk(key)) throw new UnauthorizedException();
    return { configured: this.svc.configured() };
  }

  @Post('render')
  async render(@Body() body: { key?: string; manifest?: VgManifest }) {
    if (!this.adminOk(body?.key)) throw new UnauthorizedException();
    if (!body?.manifest) throw new HttpException('manifest обязателен', HttpStatus.BAD_REQUEST);
    const r = await this.svc.submitRender(body.manifest);
    return { ok: true, ...r };
  }

  @Get('status/:jobId')
  async status(@Param('jobId') jobId: string, @Query('key') key?: string) {
    if (!this.adminOk(key)) throw new UnauthorizedException();
    const r = await this.svc.getStatus(jobId);
    return { ok: true, ...r };
  }

  @Post('cancel/:jobId')
  async cancel(@Param('jobId') jobId: string, @Body() body: { key?: string }) {
    if (!this.adminOk(body?.key)) throw new UnauthorizedException();
    return { ok: await this.svc.cancel(jobId) };
  }
}
