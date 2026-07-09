import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the single-file frontend at "/" and the eSIM checkout page at "/esim".
 * On Vercel these are bundled via functions.includeFiles ("public/**") in vercel.json;
 * resolved from a few candidate paths to work on serverless and a persistent process.
 */
@Controller()
export class FrontendController {
  private readonly index: string = FrontendController.load('index.html');
  private readonly esim: string = FrontendController.load('esim.html');
  private readonly legal: string = FrontendController.load('legal.html');
  private readonly cine: string = FrontendController.load('cine.html');
  private readonly reel: string = FrontendController.load('reel.html');
  private readonly fastReels: string = FrontendController.load('fast-reels.html');
  private readonly veryGoodFfmpeg: string = FrontendController.load('very-good-ffmpeg.html');
  private readonly publish: string = FrontendController.load('publish.html');
  private readonly hotTours: string = FrontendController.load('hot-tours.html');
  private readonly blog: string = FrontendController.load('blog.html');
  private readonly hotAdmin: string = FrontendController.load('hot-admin.html');
  private readonly reelsAdmin: string = FrontendController.load('reels-admin.html');
  private readonly manage: string = FrontendController.load('manage.html');
  private readonly reelManifest: string = FrontendController.load('reel.manifest.mjs');

  private static load(file: string): string {
    const candidates = [
      join(process.cwd(), 'public', file),
      join(__dirname, '..', '..', 'public', file),
      join(__dirname, '..', '..', '..', 'public', file),
    ];
    for (const p of candidates) {
      try { if (existsSync(p)) return readFileSync(p, 'utf8'); } catch { /* try next */ }
    }
    return '';
  }

  @Get()
  root(@Res() res: Response) {
    return this.serve(res, this.index);
  }

  @Get('esim')
  esimPage(@Res() res: Response) {
    return this.serve(res, this.esim);
  }

  @Get('legal/:doc')
  legalPage(@Res() res: Response) {
    return this.serve(res, this.legal);
  }

  @Get('cine')
  cinePage(@Res() res: Response) {
    return this.serve(res, this.cine);
  }

  @Get('reels')
  reelPage(@Res() res: Response) {
    // No caching while this montage studio is under active iteration — a stale cached copy here has
    // repeatedly masked whether a fix actually reached the browser during debugging.
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(this.reel || '<h1>ATM-travel.org</h1><p>frontend asset not found in bundle</p>');
  }

  // Multi-threaded ffmpeg.wasm needs the page to be "cross-origin isolated" (SharedArrayBuffer
  // requires it) — COOP+COEP are set ONLY on this route, not on /reels, since they can break
  // cross-origin embeds (fonts, ad script, third-party CDNs) that don't send matching CORP/CORS
  // headers. Isolating the risk to a dedicated page keeps the working /reels studio unaffected.
  @Get('fast-reels')
  fastReelsPage(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    return res.type('html').send(this.fastReels || '<h1>ATM-travel.org</h1><p>frontend asset not found in bundle</p>');
  }

  // Renders via the hosted Very Good FFmpeg API (verygoodffmpeg.com) server-side — no local
  // ffmpeg.wasm, so no SharedArrayBuffer/COOP/COEP needed here at all (unlike /fast-reels).
  @Get('very-good-ffmpeg')
  veryGoodFfmpegPage(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(this.veryGoodFfmpeg || '<h1>ATM-travel.org</h1><p>frontend asset not found in bundle</p>');
  }

  @Get('publish')
  publishPage(@Res() res: Response) {
    return this.serve(res, this.publish);
  }

  @Get('hot-tours')
  hotToursPage(@Res() res: Response) {
    return this.serve(res, this.hotTours);
  }

  @Get('blog')
  blogPage(@Res() res: Response) {
    return this.serve(res, this.blog);
  }

  @Get('hot-admin')
  hotAdminPage(@Res() res: Response) {
    return this.serve(res, this.hotAdmin);
  }

  @Get('reels-admin')
  reelsAdminPage(@Res() res: Response) {
    return this.serve(res, this.reelsAdmin);
  }

  @Get('manage')
  managePage(@Res() res: Response) {
    return this.serve(res, this.manage);
  }

  // ES module imported by reel.html; must be served with a JS MIME (rewrites send /(.*) to /api).
  @Get('reel.manifest.mjs')
  reelManifestFile(@Res() res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.type('text/javascript').send(this.reelManifest || '// reel.manifest.mjs not found');
  }

  private serve(res: Response, html: string) {
    if (html) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.type('html').send(html);
    }
    return res.status(500).type('html').send('<h1>ATM-travel.org</h1><p>frontend asset not found in bundle</p>');
  }
}
