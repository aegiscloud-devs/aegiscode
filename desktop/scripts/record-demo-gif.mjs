#!/usr/bin/env node
/**
 * Demo-GIF generator — docs/marketing-plan-social.md §6.
 *
 *   npm run demo            # from desktop/
 *   node desktop/scripts/record-demo-gif.mjs
 *
 * §6 asks for "a 40-second demo GIF at the top of the README". This drives the
 * REAL app (`desktop/main.js` + preload + renderer) under Electron with
 * `delivery/test/demo-gif-main.js` as the driver, records the live window in
 * real time, and encodes an animated GIF to `desktop/docs/demo.gif` (~40 s,
 * <= 8 MB, 1200x750).
 *
 * WHAT THE "MODEL" IS, STATED PLAINLY: it is the hermetic loopback stub from
 * `scripts/marketing-harness.mjs` — the SAME stub `npm run shots` uses. It
 * speaks the real wire formats (OpenAI-compatible SSE on 127.0.0.1) so the app
 * renders a genuinely streamed, tool-calling turn, but it performs no
 * inference. This asset therefore demonstrates the UI and the agent loop, never
 * model quality. A stray invocation cannot reach a provider: the driver refuses
 * to boot unless AEGIS_SMOKE=1 and every base is a 127.0.0.1 origin, and the
 * app's settings/sessions store is redirected to a temp profile.
 *
 * HOW IT IS RECORDED: not one pixel is synthesised, pasted or retouched. The
 * recorder brings up its own nested X server (Xephyr at 1920x1080; xvfb is not
 * installed here), points the app at the stub, and grabs the app window's
 * rectangle from that display with `ffmpeg -f x11grab` at 20 fps for the length
 * of the scripted flow. The flow runs at real time — the answer is streamed
 * token by token by the stub and rendered by the app, the model-class picker is
 * a real native popup opened with a trusted input event, and the closing beat
 * is the real tool-call approval card. Nothing is sped up; the clip is only cut
 * to length (the tail after the closing beat is trimmed, never re-timed).
 *
 * WHY IT FAILS LOUDLY: §8's "no fabricated evidence" rule. The run exits
 * non-zero — and deletes any half-made asset — if ffmpeg/ffprobe is missing,
 * the driver fails, any frame is blank/uniform, the output is not an animated
 * GIF, the duration is outside ~35-45 s, it exceeds 8 MB, or a sampled frame is
 * too flat to be a painted UI. The final `DEMO_EVIDENCE {json}` line on stdout
 * carries the frame count, fps, duration, byte size, dimensions and the
 * distinct-colour count of the sampled frames.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStubServer, startVirtualDisplay, resolveElectronBin, FAKE_KEY } from './marketing-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
const DRIVER = path.join(DESKTOP, 'test', 'demo-gif-main.js');
const OUT = path.join(DESKTOP, 'docs', 'demo.gif');

const WIDTH = 1200;
const HEIGHT = 750;
// Capture richer than we publish, so the published fps can be lowered to fit
// the byte budget without re-recording. 10 fps -> a 10 cs GIF delay -> exact.
const CAPTURE_FPS = 20;
const GIF_FPS = 10;
const TARGET_SEC = 40.0;
const MIN_SEC = 35;
const MAX_SEC = 45;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REC_MS = 80000;
// A frame whose luma span (YMAX-YMIN) is at or below this is blank/uniform:
// a painted UI frame (dark chrome + light text) spans ~200.
const UNIFORM_DELTA = 8;
// The stub's streaming cadence for the demo (the stills use 48 chars / 30 ms).
const ANSWER_CHUNK_CHARS = 8;
const ANSWER_INTERVAL_MS = 120;

const failures = [];
const passes = [];

function check(name, ok, detail) {
  const line = detail ? `${name}${ok ? '' : ` — ${detail}`}` : name;
  if (ok) passes.push(name);
  else failures.push(line);
  return Boolean(ok);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n) => `${n} bytes (${(n / 1024 / 1024).toFixed(2)} MiB)`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    maxBuffer: opts.maxBuffer || 256 * 1024 * 1024,
    env: opts.env || process.env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

/** Full per-frame pixel statistics of a PNG, via ffmpeg raw RGB. */
function frameStats(pngPath) {
  const r = run('ffmpeg', ['-v', 'error', '-i', pngPath, '-vf', 'format=rgb24', '-f', 'rawvideo', '-'], {
    encoding: null,
  });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  const b = r.stdout;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const set = new Set();
  for (let i = 0; i + 2 < b.length; i += 3) {
    const R = b[i];
    const G = b[i + 1];
    const B = b[i + 2];
    const y = 0.299 * R + 0.587 * G + 0.114 * B;
    sum += y;
    sum2 += y * y;
    n += 1;
    set.add((R << 16) | (G << 8) | B);
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { mean: +mean.toFixed(2), std: +std.toFixed(2), distinct: set.size, pixels: n };
}

function stopProcess(child, graceMs = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill('SIGINT');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-demo-'));
  const rawPath = path.join(scratch, 'raw.mkv');
  const palettePath = path.join(scratch, 'palette.png');
  const gifTmp = path.join(scratch, 'demo.gif');
  const metaPath = path.join(scratch, 'stats.txt');
  const framesDir = path.join(scratch, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  let stub = null;
  let virtual = null;
  let electron = null;
  let ffmpeg = null;
  let published = false;

  try {
    // ── preflight ───────────────────────────────────────────────────────────
    const ffmpegPresent = run('ffmpeg', ['-version']).status === 0;
    const ffprobePresent = run('ffprobe', ['-version']).status === 0;
    check('ffmpeg-present', ffmpegPresent, 'ffmpeg is required to encode the GIF');
    check('ffprobe-present', ffprobePresent, 'ffprobe is required to verify the GIF');
    if (!ffmpegPresent || !ffprobePresent) {
      return; // nothing was produced; report() below exits non-zero
    }

    const electronBin = resolveElectronBin();
    check('electron-present', Boolean(electronBin), electronBin || 'no Electron binary — run `npm ci` in desktop/ first');
    if (!electronBin) return;

    // ── hermetic stub + temp profile ────────────────────────────────────────
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-demo-ws-'));
    fs.mkdirSync(path.join(workspace, 'lib'), { recursive: true });
    stub = await startStubServer({ answerIntervalMs: ANSWER_INTERVAL_MS, answerChunkChars: ANSWER_CHUNK_CHARS });
    const apiBase = `http://127.0.0.1:${stub.port}`;
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-demo-profile-'));

    // ── the nested X display the whole run sits on ──────────────────────────
    const forcedDisplay = process.env.AEGIS_DEMO_DISPLAY || '';
    if (forcedDisplay) {
      check('headless-display', true, `AEGIS_DEMO_DISPLAY=${forcedDisplay}`);
    } else {
      virtual = await startVirtualDisplay();
      check(
        'headless-display',
        Boolean(virtual && virtual.display),
        virtual
          ? 'a display-bearing virtual X server (Xephyr) is required so ffmpeg can x11grab it; xvfb-run has no fixed display number here'
          : 'no Xephyr and no DISPLAY — cannot record'
      );
      if (!virtual || !virtual.display) return;
    }
    const display = forcedDisplay || (virtual && virtual.display);

    const env = {
      ...process.env,
      AEGIS_SMOKE: '1',
      AEGIS_API_BASE: apiBase,
      AEGIS_API_KEY: FAKE_KEY,
      AEGIS_SHOTS_STUB: apiBase,
      AEGIS_DEMO_W: String(WIDTH),
      AEGIS_DEMO_H: String(HEIGHT),
      XDG_CONFIG_HOME: userData,
      HOME: process.env.HOME || userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      DISPLAY: display,
    };
    delete env.AEGIS_MEMORY_TOKEN;
    delete env.AEGIS_TOKEN;

    check(
      'all-bases-are-loopback',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(env.AEGIS_API_BASE) && /^http:\/\/127\.0\.0\.1:\d+$/.test(env.AEGIS_SHOTS_STUB),
      `api=${env.AEGIS_API_BASE} stub=${env.AEGIS_SHOTS_STUB}`
    );

    // ── fresh asset only: never reuse a previous run's GIF ──────────────────
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    try {
      fs.unlinkSync(OUT);
    } catch {
      /* no stale asset */
    }

    // ── run the app + record in real time ───────────────────────────────────
    const switches = [
      '--no-sandbox',
      '--disable-gpu',
      '--in-process-gpu',
      '--force-device-scale-factor=1',
      DRIVER,
    ];
    electron = spawn(electronBin, switches, {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let recStart = 0;
    let recStop = 0;
    let readyInfo = null;

    const startRecording = (dx, dy) => {
      recStart = Date.now();
      const size = `${WIDTH}x${HEIGHT}`;
      ffmpeg = spawn(
        'ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-loglevel', 'error',
          '-f', 'x11grab',
          '-framerate', String(CAPTURE_FPS),
          '-video_size', size,
          '-draw_mouse', '1',
          '-i', `${display}.0+${dx},${dy}`,
          '-t', String(Math.ceil(MAX_REC_MS / 1000)),
          '-c:v', 'ffv1',
          '-level', '3',
          rawPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      ffmpeg.stderr.on('data', (d) => {
        stderr += d.toString();
      });
    };

    const finished = new Promise((resolve) => {
      const killer = setTimeout(() => {
        failures.push(`electron run timed out after ${MAX_REC_MS + 60000}ms`);
        try {
          electron.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve('timeout');
      }, MAX_REC_MS + 60000);

      electron.stdout.on('data', async (d) => {
        stdout += d.toString();
        // React to the driver's readiness marker: only now can the window be
        // grabbed, and only now is a real frame guaranteed to exist.
        if (!recStart && /(^|\n)DEMO_READY /.test(stdout)) {
          const line = stdout.split('\n').find((l) => l.startsWith('DEMO_READY '));
          try {
            readyInfo = JSON.parse(line.slice('DEMO_READY '.length));
          } catch {
            readyInfo = null;
          }
          const cb = (readyInfo && readyInfo.windowState && readyInfo.windowState.contentBounds) || { x: 0, y: 0 };
          startRecording(Math.round(cb.x || 0), Math.round(cb.y || 0));
        }
        // Stop recording the moment the closing beat ends.
        if (recStart && !recStop && /(^|\n)DEMO_DONE /.test(stdout)) {
          recStop = Date.now();
          if (ffmpeg) await stopProcess(ffmpeg);
        }
      });
      electron.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      electron.on('exit', (code, signal) => {
        clearTimeout(killer);
        resolve(signal ? `signal:${signal}` : code);
      });
    });

    const exitCode = await finished;
    // If the driver died before DEMO_DONE, make sure ffmpeg is stopped anyway.
    if (ffmpeg && !recStop) {
      recStop = Date.now();
      await stopProcess(ffmpeg);
    }

    await stub.close();
    stub = null;
    if (virtual && virtual.proc) {
      try {
        virtual.proc.kill('SIGTERM');
      } catch {
        /* gone */
      }
      virtual = { ...virtual, proc: null };
    }

    // ── driver evidence ─────────────────────────────────────────────────────
    const evLine = stdout.split('\n').find((l) => l.startsWith('DEMO_EVIDENCE '));
    let payload = null;
    if (evLine) {
      try {
        payload = JSON.parse(evLine.slice('DEMO_EVIDENCE '.length));
      } catch (err) {
        failures.push(`could not parse DEMO_EVIDENCE: ${err.message}`);
      }
    }
    if (process.env.AEGIS_DEMO_DEBUG === '1' || !payload) {
      if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-40).join('\n'));
      if (!payload && stdout.trim()) console.error(stdout.trim().split('\n').slice(-40).join('\n'));
    }
    check('driver-exit-0', exitCode === 0, `exit=${exitCode}`);
    check('driver-evidence', Boolean(payload), 'no DEMO_EVIDENCE line on stdout (AEGIS_DEMO_DEBUG=1 for the tail)');
    if (payload) {
      check('driver-ok', payload.ok === true, payload.fatal ? `fatal: ${payload.fatal}` : '');
      for (const c of payload.checks || []) check(`driver:${c.name}`, Boolean(c.ok), c && !c.ok ? String(c.detail) : '');
    }
    check('recording-started', recStart > 0, 'the driver never reached DEMO_READY');
    check('recording-stopped', recStop > 0, 'the driver never reached DEMO_DONE');

    // ── the raw recording ───────────────────────────────────────────────────
    let rawOk = false;
    try {
      rawOk = fs.statSync(rawPath).size > 0;
    } catch {
      rawOk = false;
    }
    check('raw-recording-written', rawOk, `expected a non-empty ${path.basename(rawPath)}`);
    if (!rawOk) return;

    const rawProbe = run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-count_frames',
      '-show_entries', 'stream=nb_read_frames,avg_frame_rate,width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      rawPath,
    ]);
    let rawInfo = null;
    try {
      rawInfo = JSON.parse(rawProbe.stdout);
    } catch {
      rawInfo = null;
    }
    const rawDur = rawInfo && rawInfo.format ? Number(rawInfo.format.duration) : NaN;
    check('raw-recording-has-duration', Number.isFinite(rawDur) && rawDur > 5, `ffprobe format.duration=${rawDur}`);

    // ── EVERY frame is checked for blankness/uniformity in one ffmpeg pass ──
    const statsRun = run('ffmpeg', [
      '-v', 'error',
      '-i', rawPath,
      '-vf', `signalstats,metadata=print:file=${metaPath}`,
      '-f', 'null',
      '-',
    ]);
    let frameSpans = [];
    if (statsRun.status === 0) {
      const text = (() => {
        try {
          return fs.readFileSync(metaPath, 'utf8');
        } catch {
          return '';
        }
      })();
      let cur = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('frame:')) {
          if (cur) frameSpans.push(cur);
          cur = {};
        }
        const m = /lavfi\.signalstats\.(YMIN|YMAX|YAVG)=([0-9.]+)/.exec(line);
        if (m && cur) cur[m[1]] = Number(m[2]);
      }
      if (cur) frameSpans.push(cur);
    }
    const blankFrames = frameSpans.filter((f) => f.YMIN !== undefined && f.YMAX !== undefined && f.YMAX - f.YMIN <= UNIFORM_DELTA).length;
    check('every-frame-analysed', frameSpans.length > 0, `signalstats reported ${frameSpans.length} frame(s)`);
    check(
      'no-blank-or-uniform-frames',
      frameSpans.length > 0 && blankFrames === 0,
      `${blankFrames} of ${frameSpans.length} frame(s) have a luma span <= ${UNIFORM_DELTA} (blank/flat)`
    );
    const spans = frameSpans.filter((f) => f.YMAX !== undefined && f.YMIN !== undefined).map((f) => f.YMAX - f.YMIN);
    const minSpan = spans.length ? Math.min(...spans) : 0;
    const maxSpan = spans.length ? Math.max(...spans) : 0;

    // ── encode: cut to length, then palettegen/paletteuse (no gifski here) ──
    const trimSec = rawDur > TARGET_SEC + 0.6 ? TARGET_SEC : null;
    const trimArgs = trimSec ? ['-t', String(trimSec)] : [];

    const paletteRun = run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...trimArgs,
      '-i', rawPath,
      '-vf', `fps=${GIF_FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,palettegen=max_colors=256:stats_mode=diff`,
      '-frames:v', '1',
      palettePath,
    ]);
    check('palette-generated', paletteRun.status === 0 && fs.existsSync(palettePath), (paletteRun.stderr || '').trim().slice(0, 300));

    const gifRun = run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...trimArgs,
      '-i', rawPath,
      '-i', palettePath,
      '-lavfi', `[0:v]fps=${GIF_FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0',
      gifTmp,
    ]);
    check('gif-encoded', gifRun.status === 0 && fs.existsSync(gifTmp), (gifRun.stderr || '').trim().slice(0, 300));
    if (!fs.existsSync(gifTmp)) return;

    // ── verify the GIF before it is published ───────────────────────────────
    const gifBuf = fs.readFileSync(gifTmp);
    const magic = gifBuf.toString('ascii', 0, 6);
    const hasNetscape = gifBuf.includes(Buffer.from('NETSCAPE2.0', 'ascii'));
    const gifProbe = run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-count_frames',
      '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate',
      '-show_entries', 'format=duration',
      '-of', 'json',
      gifTmp,
    ]);
    let gifInfo = null;
    try {
      gifInfo = JSON.parse(gifProbe.stdout);
    } catch {
      gifInfo = null;
    }
    const gs = (gifInfo && gifInfo.streams && gifInfo.streams[0]) || {};
    const gifFrames = Number(gs.nb_read_frames);
    // GIF delays are centiseconds; at 10 fps each delay is exactly 10 cs.
    const gifDuration = Number.isFinite(gifFrames) ? gifFrames / GIF_FPS : NaN;
    const gifBytes = gifBuf.length;

    check('gif-magic', magic === 'GIF89a' || magic === 'GIF87a', `header is ${JSON.stringify(magic)}`);
    check('gif-is-animated', Number.isFinite(gifFrames) && gifFrames > 1 && hasNetscape, `${gifFrames} frame(s), Netscape loop ext=${hasNetscape}`);
    check('gif-dimensions', Number(gs.width) === WIDTH && Number(gs.height) === HEIGHT, `ffprobe reports ${gs.width}x${gs.height}`);
    check('gif-duration-in-range', gifDuration >= MIN_SEC && gifDuration <= MAX_SEC, `${gifDuration.toFixed(2)}s (want ${MIN_SEC}-${MAX_SEC}s)`);
    check('gif-under-byte-budget', gifBytes > 0 && gifBytes <= MAX_BYTES, `${fmtBytes(gifBytes)} (limit ${fmtBytes(MAX_BYTES)})`);

    // ── sample frames at the three claimed beats and prove they are painted ──
    // Marks arrive in two parts: DEMO_READY carries `ready` (all that existed at
    // that point), DEMO_DONE carries the later beats. Merging is load-bearing —
    // preferring either one alone silently samples the wrong wall-clock instant
    // (a mismatch here once produced three identical frames of the first beat).
    const marks = { ...((readyInfo && readyInfo.marks) || {}), ...((payload && payload.marks) || {}) };
    // Anchors: marks are ms since the driver's t0 (epoch ms, carried in both
    // payloads); recStart is the epoch instant ffmpeg was spawned. So a mark's
    // place on the recording timeline is `t0 + mark - recStart`, in seconds.
    const t0Epoch = (payload && payload.t0) || (readyInfo && readyInfo.t0) || null;
    const at = (markMs, leadSec) => {
      if (!Number.isFinite(markMs) || !t0Epoch || !recStart) return null;
      return (t0Epoch + markMs - recStart) / 1000 + leadSec;
    };
    const span = gifDuration || TARGET_SEC;
    const clamp = (t) => (t === null ? null : +Math.max(0.3, Math.min(span - 0.3, t)).toFixed(2));
    const wanted = [
      { name: 'streamed-answer', t: clamp(at(marks.answerStreamed, -1.2)) },
      { name: 'model-class-picker', t: clamp(at(marks.pickerOpened, 0.9)) },
      { name: 'tool-approval-card', t: clamp(at(marks.recordingEnd, -1.5)) },
    ].map((s, i) => ({
      name: s.name,
      t: s.t === null ? +(0.25 + i * 0.28).toFixed(2) * span : s.t,
    }));
    if (wanted.some((s) => s.t === null)) {
      check('beat-marks-anchored', false, 'driver did not supply t0 + marks; sampled frames are placeholders');
    } else {
      check('beat-marks-anchored', true, wanted.map((s) => `${s.name}@${s.t}s`).join(' '));
    }

    const samples = [];
    for (const s of wanted) {
      const png = path.join(framesDir, `${s.name}.png`);
      const ex = run('ffmpeg', ['-y', '-v', 'error', '-ss', String(s.t), '-i', gifTmp, '-frames:v', '1', png]);
      const stats = ex.status === 0 ? frameStats(png) : null;
      const sha = stats ? createHash('sha256').update(fs.readFileSync(png)).digest('hex').slice(0, 16) : null;
      samples.push({ name: s.name, tSec: s.t, sha, ...(stats || {}) });
      check(`sample-painted:${s.name}`, Boolean(stats) && stats.distinct > 64 && stats.std > 8, stats ? `distinct=${stats.distinct} std=${stats.std}` : 'frame could not be extracted');
    }
    // The three samples must not be identical frames (they show different beats).
    // Compared by content hash, not by rounded statistics: two different beats can
    // share a mean/std/distinct triple, and that would pass a stats-only check.
    const hashes = samples.map((s) => s.sha).filter(Boolean);
    const distinctKeys = new Set(hashes.length === samples.length ? hashes : samples.map((s) => `${s.mean}|${s.std}|${s.distinct}`));
    check('sampled-frames-are-distinct', distinctKeys.size === samples.length, `${distinctKeys.size} distinct sample(s) of ${samples.length} (${samples.map((s) => s.sha || 'n/a').join(' ')})`);

    // ── publish only a GIF that passed every check ──────────────────────────
    if (failures.length === 0) {
      fs.copyFileSync(gifTmp, OUT);
      published = true;
    }

    report({
      frames: gifFrames,
      fps: GIF_FPS,
      durationSec: +gifDuration.toFixed(2),
      bytes: gifBytes,
      width: WIDTH,
      height: HEIGHT,
      gifAnimated: Boolean(Number.isFinite(gifFrames) && gifFrames > 1 && hasNetscape),
      samples,
      rawDur: Number.isFinite(rawDur) ? +rawDur.toFixed(2) : null,
      trimmed: trimSec !== null,
      frameSpan: { min: minSpan, max: maxSpan, analysed: frameSpans.length, blank: blankFrames },
      payload,
      display,
      stubState: stub ? stub.state : undefined,
      published,
    });
  } finally {
    // ── always tear everything down; publish nothing unless it passed ───────
    if (ffmpeg) await stopProcess(ffmpeg).catch(() => {});
    if (electron && electron.exitCode === null && !electron.signalCode) {
      try {
        electron.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (virtual && virtual.proc) {
      try {
        virtual.proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (stub) await stub.close().catch(() => {});
    if (!published) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (!published) {
      try {
        fs.unlinkSync(OUT);
      } catch {
        /* nothing to remove */
      }
    }
  }
}

function report(ev = null) {
  console.log('\n── demo GIF (plan §6) ─────────────────────────────────────────');
  for (const p of passes) console.log(`  PASS  ${p}`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  if (ev) {
    console.log(
      `\n  GIF: ${ev.width}x${ev.height}, ${ev.frames} frame(s) @ ${ev.fps} fps, ${ev.durationSec}s, ${fmtBytes(ev.bytes)}`
    );
    console.log(`  animated=${ev.gifAnimated} raw=${ev.rawDur}s trimmed=${ev.trimmed} display=${ev.display}`);
    console.log(
      `  frames analysed=${ev.frameSpan.analysed}, luma span min=${ev.frameSpan.min} max=${ev.frameSpan.max}, blank=${ev.frameSpan.blank}`
    );
    for (const s of ev.samples) {
      console.log(`    sample ${s.name.padEnd(20)} t=${String(s.tSec).padStart(6)}s  mean=${s.mean} std=${s.std} distinct=${s.distinct}`);
    }
    if (ev.payload) console.log(`  driver: ok=${ev.payload.ok} fatal=${ev.payload.fatal || 'none'}`);
  }
  console.log(`\n  ${failures.length === 0 ? 'OK' : 'FAILED'} — ${passes.length} passed, ${failures.length} failed\n`);

  const evidence = {
    ok: failures.length === 0,
    published: ev ? ev.published : false,
    file: 'desktop/docs/demo.gif',
    frames: ev ? ev.frames : null,
    fps: ev ? ev.fps : null,
    durationSec: ev ? ev.durationSec : null,
    bytes: ev ? ev.bytes : null,
    width: ev ? ev.width : null,
    height: ev ? ev.height : null,
    gifAnimated: ev ? ev.gifAnimated : false,
    sampleFrameDistinct: ev ? ev.samples.map((s) => s.distinct) : [],
    sampleFrameStats: ev ? ev.samples.map((s) => ({ name: s.name, tSec: s.tSec, mean: s.mean, std: s.std, distinct: s.distinct })) : [],
    rawDurationSec: ev ? ev.rawDur : null,
    frameSpan: ev ? ev.frameSpan : null,
    capturedFps: CAPTURE_FPS,
    display: ev ? ev.display : null,
    checksPassed: passes.length,
    checksFailed: failures.length,
  };
  console.log(`DEMO_EVIDENCE ${JSON.stringify(evidence)}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  failures.push(`unhandled: ${(err && err.stack) || err}`);
  report(null);
});
