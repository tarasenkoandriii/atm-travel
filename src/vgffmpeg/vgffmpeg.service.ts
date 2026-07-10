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
  // Optional per-format override for clips[0]'s URL (same start/duration, just different footage) —
  // used for the globe intro, which is recorded separately per aspect ratio client-side (matching
  // /cine's approach: one shared animation pass, center-cropped per format) so it fills the frame
  // properly in all 3 instead of one recording getting letterboxed/pillarboxed for the others.
  // Keyed by our format names: '9x16' | '4x5' | '16x9'.
  introByFormat?: Record<string, string>;
};

// The 3 standard social aspect ratios (vertical, square-ish, and landscape), so
// "3 формата ... как в reels" produces the same crops here.
const SOCIAL_FORMATS: { name: string; w: number; h: number }[] = [
  { name: '9x16', w: 1080, h: 1920 },
  { name: '4x5', w: 1080, h: 1350 },
  { name: '16x9', w: 1920, h: 1080 },
];

const SUPPORTED_TRANSITIONS = new Set([
  'crossfade', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'circleclose',
]);
// The "crossfade" alias in our manifest maps to ffmpeg's xfade "fade" transition name (ffmpeg has no
// literal "crossfade" xfade type — a plain cross-dissolve IS ffmpeg's "fade"). Every other name in
// SUPPORTED_TRANSITIONS matches an ffmpeg xfade transition name 1:1, so adding a new one later is
// just adding it to the Set above (see "должна позволять легко добавлять новые типы" in the spec).
const XFADE_NAME: Record<string, string> = { crossfade: 'fade' };

/**
 * Translates our higher-level "clips + voiceover + transition" manifest into raw FFmpeg
 * filter-graph commands, then submits them to the real, hosted Very Good FFmpeg API
 * (https://verygoodffmpeg.com — confirmed live service; POST /api/ffmpeg takes exactly this
 * input_files/output_files/ffmpeg_commands shape and runs arbitrary ffmpeg commands server-side,
 * and — confirmed by their own docs example — accepts MULTIPLE ffmpeg_commands/output_files in one
 * job, e.g. transcoding to 1080p/720p/480p in a single request. We use that same mechanism to
 * produce all 3 social aspect ratios (9:16, 4:5, 16:9) as one job instead of three separate ones).
 *
 * Each format gets its own full filter_complex (own scale/pad, since W/H differ), but the shared
 * per-clip trim args and the xfade timeline (offsets depend only on clip DURATIONS, not W/H) are
 * computed once and reused across all 3 — no need to redo that math per format.
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

  // Builds the filter_complex + full command for ONE target format, given the already-validated,
  // shared clip list/timeline. Pulled out of buildCommands() so it can be called once per format
  // without repeating clip validation or the xfade-offset derivation (format-independent) each time.
  private buildOneCommand(opts: {
    clips: { url: string; start: number; duration: number }[];
    transDur: number; xfadeName: string; fillMode: 'freeze' | 'loop';
    W: number; H: number; target: number; inputArgs: string; voiceIdx: number; outName: string;
  }): string {
    const { clips, transDur, xfadeName, fillMode, W, H, target, inputArgs, voiceIdx, outName } = opts;
    const filters: string[] = [];
    const rawTotal = clips.reduce((s, c) => s + c.duration, 0) - (clips.length - 1) * transDur;
    const willLoopFill = fillMode === 'loop' && rawTotal < target - 0.01;
    const lastIdx = clips.length - 1;
    clips.forEach((c, i) => {
      const outLabel = willLoopFill && i === lastIdx ? `v${i}pre` : `v${i}`;
      filters.push(
        // increase+crop (fill the frame, crop the excess) — NOT decrease+pad (fit inside, black
        // bars). This matches the scaling convention used everywhere else in this project
        // (cine.html's canvas coverDraw) — no
        // letterboxing/pillarboxing anywhere in the final output.
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[${outLabel}]`,
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
    return `${inputArgs} -filter_complex "${filterComplex}" -map [${finalLabel}] -map ${voiceIdx}:a ` +
      `-t ${target.toFixed(3)} -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -ar 48000 -movflags +faststart {{${outName}}}`;
  }

  // ── Filter graph construction — one command per social format (9:16, 4:5, 16:9) ───────────────
  buildCommands(m: VgManifest): { inputFiles: Record<string, string>; commands: { format: string; outputName: string; command: string }[]; totalDurationSec: number } {
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
    inputFiles.voiceover = m.voiceover.url;

    // If the manifest explicitly sets width/height, honor that as a SINGLE custom format instead of
    // the standard 3 (keeps the API usable for a one-off custom size); otherwise produce all 3.
    const formats = (m.width && m.height)
      ? [{ name: `${Math.round(m.width)}x${Math.round(m.height)}`, w: Math.round(m.width), h: Math.round(m.height) }]
      : SOCIAL_FORMATS;
    const voiceIdx = clips.length; // 0-based index of the voiceover input (same slot in every command)
    const target = m.voiceover.duration;

    const commands = formats.map((fmt) => {
      // clips[0] (the globe intro) may have a per-format URL (recorded/cropped separately for each
      // aspect ratio, like /cine does) — everything else (real B-roll) is identical across formats.
      // input_files is ONE shared map for the whole job, so an intro that differs per format needs
      // its own placeholder key per format; clips sharing the same footage keep a single shared key.
      const introOverrideUrl = m.introByFormat?.[fmt.name];
      clips.forEach((c, i) => {
        const useOverride = i === 0 && introOverrideUrl;
        const key = useOverride ? `clip0_${fmt.name}` : `clip${i}`;
        inputFiles[key] = useOverride ? introOverrideUrl! : c.url;
      });
      const inputArgsForFmt = clips
        .map((c, i) => {
          const key = i === 0 && introOverrideUrl ? `clip0_${fmt.name}` : `clip${i}`;
          return `-ss ${c.start.toFixed(3)} -t ${c.duration.toFixed(3)} -i {{${key}}}`;
        })
        .concat([`-i {{voiceover}}`])
        .join(' ');
      return {
        format: fmt.name,
        outputName: `output-${fmt.name}.mp4`,
        command: this.buildOneCommand({
          clips, transDur, xfadeName, fillMode, W: fmt.w, H: fmt.h, target, inputArgs: inputArgsForFmt, voiceIdx,
          outName: `output-${fmt.name}.mp4`,
        }),
      };
    });

    return { inputFiles, commands, totalDurationSec: target };
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

  async submitRender(manifest: VgManifest): Promise<{ jobId: string; status: string; formats: string[] }> {
    const key = this.apiKey();
    if (!key) throw new HttpException('VGFFMPEG_API_KEY не настроен', HttpStatus.SERVICE_UNAVAILABLE);
    const { inputFiles, commands } = this.buildCommands(manifest);
    // Idempotency key derived from the manifest content — resubmitting the identical manifest
    // (e.g. a retried client request) reuses the same key so a well-behaved API can dedupe it.
    const idemKey = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    this.logger.log(`submitRender idempotencyKey=${idemKey.slice(0, 12)} clips=${manifest.clips.length} formats=${commands.map((c) => c.format).join(',')}`);
    try {
      return await this.withRetry(async () => {
        const res = await fetch(`${this.base}/ffmpeg`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
          // Multiple ffmpeg_commands + output_files in ONE job — confirmed supported by the API's
          // own docs example (transcoding to 1080p/720p/480p in a single request).
          body: JSON.stringify({
            input_files: inputFiles,
            output_files: commands.map((c) => c.outputName),
            ffmpeg_commands: commands.map((c) => c.command),
          }),
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
        return { jobId, status: d.status || 'queued', formats: commands.map((c) => c.format) };
      }, 'submitRender');
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      throw new HttpException(`не удалось отправить задачу в Very Good FFmpeg: ${e?.message || e}`, HttpStatus.BAD_GATEWAY);
    }
  }

  async getStatus(jobId: string): Promise<{ status: string; outputs?: Record<string, string>; error?: string }> {
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
        // We now submit up to 3 outputs (one per social format) in a single job — output_files is
        // an object keyed by the filenames we chose ("output-9x16.mp4" etc.) once the job finishes.
        // Return the whole map rather than picking just one, so the caller can show all formats.
        const outputs: Record<string, string> | undefined = (d.output_files && Object.keys(d.output_files).length)
          ? d.output_files
          : (Array.isArray(d.result) && d.result.length)
            ? Object.fromEntries(d.result.map((r: any, i: number) => [r.file_name || `output${i}`, r.download_url || r.url]))
            : undefined;
        // error_message is "" (empty string, not null) when there's no error — only surface it if non-empty.
        const errorMsg = d.error_message || d.error;
        // Confirmed real value (2026-07-09): a finished job's status is "succeeded", NOT "completed" —
        // normalize it (and a few plausible synonyms) to our own vocabulary here, in ONE place, so
        // callers (and the frontend's polling loop) only ever need to check for 'completed'/'failed'.
        const SUCCESS = new Set(['succeeded', 'completed', 'success', 'done', 'finished']);
        const FAILURE = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);
        const status = SUCCESS.has(d.status) ? 'completed' : FAILURE.has(d.status) ? 'failed' : d.status;
        return { status, outputs, error: errorMsg ? errorMsg : undefined };
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
