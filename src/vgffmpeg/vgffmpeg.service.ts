import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

export type VgClip = { url: string; start: number; duration: number };
export type VgManifest = {
  voiceover: { url: string; duration: number };
  transition?: { type?: string; duration?: number };
  fillMode?: 'freeze' | 'loop';
  clips: VgClip[];
  width?: number;
  height?: number;
};

const SUPPORTED_TRANSITIONS = new Set([
  'crossfade', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'circleclose',
]);
// The "crossfade" alias in our manifest maps to ffmpeg's xfade "fade" transition name (ffmpeg has no
// literal "crossfade" xfade type — a plain cross-dissolve IS ffmpeg's "fade"). Every other name in
// SUPPORTED_TRANSITIONS matches an ffmpeg xfade transition name 1:1, so adding a new one later is
// just adding it to the Set above (see "должна позволять легко добавлять новые типы" in the spec).
const XFADE_NAME: Record<string, string> = { crossfade: 'fade' };

/**
 * Translates our higher-level "clips + voiceover + transition" manifest into a single raw FFmpeg
 * filter-graph command, then submits it to the real, hosted Very Good FFmpeg API
 * (https://verygoodffmpeg.com — confirmed live service; POST /api/ffmpeg takes exactly this
 * input_files/output_files/ffmpeg_commands shape and runs arbitrary ffmpeg commands server-side).
 *
 * We build ONE filter_complex covering trim + xfade transitions + duration alignment + audio
 * replacement in a single pass — no intermediate re-encoding, per the "единый FFmpeg Filter Graph"
 * requirement.
 */
@Injectable()
export class VgFfmpegService {
  private readonly logger = new Logger(VgFfmpegService.name);
  private readonly base = 'https://verygoodffmpeg.com/api';

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string | undefined {
    return this.config.get<string>('VGFFMPEG_API_KEY');
  }

  configured(): boolean {
    return !!this.apiKey();
  }

  // ── Filter graph construction ──────────────────────────────────────────────────────────────
  buildCommand(m: VgManifest): { inputFiles: Record<string, string>; command: string; outputName: string; totalDurationSec: number } {
    if (!m.clips || !m.clips.length) throw new HttpException('clips is empty', HttpStatus.BAD_REQUEST);
    if (m.clips.length > 500) throw new HttpException('слишком много клипов (максимум 500)', HttpStatus.BAD_REQUEST);
    if (!m.voiceover || !m.voiceover.url || !(m.voiceover.duration > 0)) {
      throw new HttpException('voiceover.url/duration обязательны', HttpStatus.BAD_REQUEST);
    }

    const transType = (m.transition?.type || 'crossfade').toLowerCase();
    if (!SUPPORTED_TRANSITIONS.has(transType)) {
      throw new HttpException(`неподдерживаемый transition.type: ${transType}`, HttpStatus.BAD_REQUEST);
    }
    const xfadeName = XFADE_NAME[transType] || transType;
    const rawTransDur = Number(m.transition?.duration);
    const transDur = Math.max(0.05, Number.isFinite(rawTransDur) ? rawTransDur : 0.5);
    const fillMode = m.fillMode === 'loop' ? 'loop' : 'freeze';
    const W = Math.min(3840, Math.max(240, Math.round(m.width || 1080)));
    const H = Math.min(3840, Math.max(240, Math.round(m.height || 1920)));

    // Validate + clamp each clip's start/duration (спека: "duration превышает остаток — уменьшить").
    // We don't know each source file's real length server-side ahead of time (no ffprobe pass —
    // that would mean a second pass, which we're avoiding), so we trust the manifest's numbers but
    // guard against obviously-invalid values.
    const clips = m.clips.map((c, i) => {
      if (!c.url) throw new HttpException(`clips[${i}].url отсутствует`, HttpStatus.BAD_REQUEST);
      const start = Math.max(0, Number(c.start) || 0);
      const rawDur = Number(c.duration);
      if (!Number.isFinite(rawDur) || rawDur <= 0) throw new HttpException(`clips[${i}].duration должен быть > 0`, HttpStatus.BAD_REQUEST);
      return { url: c.url, start, duration: Math.max(0.1, rawDur) };
    });

    const inputFiles: Record<string, string> = {};
    clips.forEach((c, i) => { inputFiles[`clip${i}`] = c.url; });
    inputFiles.voiceover = m.voiceover.url;

    // Input-level trim (-ss/-t) is efficient (seeks before decode) and keeps this a single pass —
    // no separate trim filter needed. setpts normalizes each stream to start at t=0 so xfade offsets
    // (which are timeline-relative) line up correctly.
    const inputArgs = clips
      .map((c, i) => `-ss ${c.start.toFixed(3)} -t ${c.duration.toFixed(3)} -i {{clip${i}}}`)
      .concat([`-i {{voiceover}}`])
      .join(' ');

    const filters: string[] = [];
    // rawTotal only depends on clip durations, so it's knowable before building any filters —
    // used here to decide up front whether the last clip's stream needs to be split (loop fillMode
    // consumes it a second time, in addition to the main xfade chain — ffmpeg filter labels can only
    // be used as input once each unless explicitly split).
    const rawTotal = clips.reduce((s, c) => s + c.duration, 0) - (clips.length - 1) * transDur;
    const target = m.voiceover.duration;
    const willLoopFill = fillMode === 'loop' && rawTotal < target - 0.01;
    const lastIdx = clips.length - 1;
    clips.forEach((c, i) => {
      const outLabel = willLoopFill && i === lastIdx ? `v${i}pre` : `v${i}`;
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[${outLabel}]`,
      );
    });
    if (willLoopFill) {
      // The last clip's (scaled) footage is needed twice — once in the main chain, once as the
      // source to loop for the deficit — split it into two independent copies up front.
      filters.push(`[v${lastIdx}pre]split=2[v${lastIdx}][v${lastIdx}_dup]`);
    }

    // Chain xfade transitions: offset_k = sum(duration_0..duration_{k-1}) - k*transDur (see the
    // ЮНИТ-tested derivation — each xfade starts transDur seconds before the running total ends).
    let cum = 0;
    let lastLabel = 'v0';
    for (let k = 1; k < clips.length; k++) {
      cum += clips[k - 1].duration;
      const offset = +(cum - k * transDur).toFixed(3);
      if (offset < 0) throw new HttpException(`переход между клипами ${k - 1} и ${k} длиннее самих клипов — уменьшите transition.duration`, HttpStatus.BAD_REQUEST);
      const outLabel = k === clips.length - 1 ? 'vchain' : `x${k}`;
      filters.push(`[${lastLabel}][v${k}]xfade=transition=${xfadeName}:duration=${transDur.toFixed(3)}:offset=${offset}[${outLabel}]`);
      lastLabel = outLabel;
    }
    if (clips.length === 1) { filters.push(`[v0]null[vchain]`); lastLabel = 'vchain'; }

    let finalLabel = 'vchain';
    if (rawTotal > target + 0.01) {
      // Longer than the voiceover — cut the tail (handled by -t on the output, see below); no extra
      // filter needed since -t truncates the encoded output regardless of filter-graph length.
    } else if (rawTotal < target - 0.01) {
      const deficit = +(target - rawTotal).toFixed(3);
      if (fillMode === 'freeze') {
        filters.push(`[vchain]tpad=stop_mode=clone:stop_duration=${deficit}[vpad]`);
        finalLabel = 'vpad';
      } else {
        // loop: re-play the LAST clip's own (already-scaled) footage to cover the deficit, looping
        // it if the deficit exceeds that clip's own length, then xfade it onto the end the same way
        // as any other clip — reuses the exact same chaining mechanism instead of a bespoke path.
        // The appended segment must be trimmed to (deficit + transDur), not just deficit: the xfade
        // that welds it on consumes transDur seconds of overlap, which would otherwise leave the
        // final output exactly transDur seconds short of the voiceover (verified by a unit test
        // before this fix landed).
        const lastDur = clips[lastIdx].duration;
        const loopTrimDur = deficit + transDur;
        const loopCount = Math.ceil(loopTrimDur / lastDur);
        filters.push(`[v${lastIdx}_dup]loop=loop=${loopCount}:size=${Math.ceil(lastDur * 30)}:start=0,trim=duration=${loopTrimDur.toFixed(3)},setpts=PTS-STARTPTS[vloop]`);
        const offset2 = +(rawTotal - transDur).toFixed(3);
        filters.push(`[vchain][vloop]xfade=transition=${xfadeName}:duration=${transDur.toFixed(3)}:offset=${Math.max(0, offset2)}[vpad]`);
        finalLabel = 'vpad';
      }
    }

    const filterComplex = filters.join(';');
    const voiceIdx = clips.length; // 0-based index of the voiceover input
    const outName = 'output.mp4';
    const command =
      `${inputArgs} -filter_complex "${filterComplex}" -map [${finalLabel}] -map ${voiceIdx}:a ` +
      `-t ${target.toFixed(3)} -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -ar 48000 -movflags +faststart {{${outName}}}`;

    return { inputFiles, command, outputName: outName, totalDurationSec: target };
  }

  // ── Real API calls (server-side only — API key never reaches the browser) ────────────────────
  private async withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e: any) {
        lastErr = e;
        const status = e?.status;
        const transient = !status || status === 429 || status >= 500;
        this.logger.warn(`${label} attempt ${i + 1}/${attempts} failed: ${e?.message || e}${transient ? ' (retrying)' : ' (not transient, giving up)'}`);
        if (!transient || i === attempts - 1) break;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
      }
    }
    throw lastErr;
  }

  async submitRender(manifest: VgManifest): Promise<{ jobId: string; status: string }> {
    const key = this.apiKey();
    if (!key) throw new HttpException('VGFFMPEG_API_KEY не настроен', HttpStatus.SERVICE_UNAVAILABLE);
    const { inputFiles, command, outputName } = this.buildCommand(manifest);
    // Idempotency key derived from the manifest content — resubmitting the identical manifest
    // (e.g. a retried client request) reuses the same key so a well-behaved API can dedupe it.
    const idemKey = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    this.logger.log(`submitRender idempotencyKey=${idemKey.slice(0, 12)} clips=${manifest.clips.length}`);
    try {
      return await this.withRetry(async () => {
        const res = await fetch(`${this.base}/ffmpeg`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
          body: JSON.stringify({ input_files: inputFiles, output_files: [outputName], ffmpeg_commands: [command] }),
        });
        const text = await res.text();
        let j: any = {}; try { j = JSON.parse(text); } catch { /* keep raw text for the error below */ }
        if (!res.ok) { const e: any = new Error(`vgffmpeg submit ${res.status}: ${text.slice(0, 500)}`); e.status = res.status; throw e; }
        // Confirmed real response shape (2026-07-09): the actual job fields are nested one level
        // down under "data" — { "data": { "id": "...", "status": "queued", "error_message": "",
        // "output_files": {}, ... } } — NOT flat at the top level. Falling back to top-level too in
        // case a future API version or a different endpoint ever returns it unwrapped.
        const d = j?.data || j;
        const jobId = d.id || d.jobId || d.job_id;
        if (!jobId) {
          this.logger.error(`submitRender: no id/jobId/job_id in response — raw body: ${text.slice(0, 1000)}`);
          throw new HttpException('ответ Very Good FFmpeg не содержит id задачи — см. логи сервера для точного формата ответа', HttpStatus.BAD_GATEWAY);
        }
        return { jobId, status: d.status || 'queued' };
      }, 'submitRender');
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      throw new HttpException(`не удалось отправить задачу в Very Good FFmpeg: ${e?.message || e}`, HttpStatus.BAD_GATEWAY);
    }
  }

  async getStatus(jobId: string): Promise<{ status: string; output?: string; error?: string }> {
    const key = this.apiKey();
    if (!key) throw new HttpException('VGFFMPEG_API_KEY не настроен', HttpStatus.SERVICE_UNAVAILABLE);
    if (!jobId || jobId === 'undefined' || jobId === 'null') {
      throw new HttpException('пустой или некорректный jobId — задача не была отправлена успешно', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.withRetry(async () => {
        const res = await fetch(`${this.base}/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${key}` } });
        const text = await res.text();
        if (!res.ok) { const e: any = new Error(`vgffmpeg status ${res.status}: ${text.slice(0, 500)}`); e.status = res.status; throw e; }
        let j: any = {}; try { j = JSON.parse(text); } catch { this.logger.error(`getStatus: non-JSON response — ${text.slice(0, 500)}`); }
        // Same "data" envelope as the submit response — see the comment in submitRender().
        const d = j?.data || j;
        const output = d.output || d.output_url || d.url
          || (d.output_files && (d.output_files[Object.keys(d.output_files)[0]] || undefined))
          || (Array.isArray(d.result) && d.result[0] && (d.result[0].download_url || d.result[0].url))
          || undefined;
        // error_message is "" (empty string, not null) when there's no error — only surface it if non-empty.
        const errorMsg = d.error_message || d.error;
        return { status: d.status, output, error: errorMsg ? errorMsg : undefined };
      }, 'getStatus');
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      throw new HttpException(`не удалось получить статус задачи: ${e?.message || e}`, HttpStatus.BAD_GATEWAY);
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const key = this.apiKey();
    if (!key) return false;
    try {
      const res = await fetch(`${this.base}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
      return res.ok;
    } catch { return false; }
  }
}
