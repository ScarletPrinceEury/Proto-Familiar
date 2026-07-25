/**
 * Measurable properties of a reference voice clip (voice spec §6.5).
 *
 * The donated voice clips arrive as anonymous ids — `0a67`, `1410` — with no
 * names, no descriptions, nothing. 228 of them. A picker that lists 228
 * identical-looking ids is not a choice, it is paralysis, and for the people
 * this project is for that is an access barrier rather than a nuisance.
 *
 * So: code measures what can be measured, and my human judges what has to be
 * heard. These features give the picker something to sort and filter by
 * without anyone listening to 228 clips first; prose descriptions are written
 * only for the handful that make the curated shortlist.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────
 * It does not label a voice's gender. Median pitch correlates with perceived
 * gender but does not determine it — timbre, resonance and prosody carry at
 * least as much — so an algorithmic "male/female/androgynous" tag would be
 * wrong a good fraction of the time AND presumptuous about a real person who
 * donated their voice. The picker shows a measured number in hertz and lets
 * the ward listen. A number is honest about being a number.
 *
 * Everything here is pure and dependency-free: a WAV parser and some
 * arithmetic over the samples. Code owns the values (CLAUDE.md's exact-values
 * rule) — nothing here is a judgement dressed as a measurement.
 */

/** Typical spoken pitch sits well inside this; the bounds only stop the detector chasing noise. */
export const F0_MIN_HZ = 60;
export const F0_MAX_HZ = 400;

/**
 * Parse a RIFF/WAVE buffer into mono float samples.
 *
 * Handles 16/24/32-bit PCM and 32-bit float, mixing any channel count down to
 * mono — a reference clip is judged as one voice, not as a stereo image.
 * Returns null rather than throwing on anything it does not understand: this
 * runs over files fetched from elsewhere, and one odd clip must not take a
 * catalogue build down.
 */
export function parseWav(buffer) {
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

    let pos = 12;
    let fmt = null;
    let dataStart = -1;
    let dataLen = 0;

    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ') {
        fmt = {
          format: buf.readUInt16LE(body),
          channels: buf.readUInt16LE(body + 2),
          sampleRate: buf.readUInt32LE(body + 4),
          bitsPerSample: buf.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        dataStart = body;
        // A truncated file declares more than it holds; trust the bytes present.
        dataLen = Math.min(size, buf.length - body);
      }
      pos = body + size + (size % 2); // chunks are word-aligned
    }

    if (!fmt || dataStart < 0 || !fmt.sampleRate || !fmt.channels) return null;

    const bytesPerSample = fmt.bitsPerSample / 8;
    if (!bytesPerSample || bytesPerSample > 4) return null;
    const frameCount = Math.floor(dataLen / (bytesPerSample * fmt.channels));
    if (frameCount <= 0) return null;

    const mono = new Float32Array(frameCount);
    const isFloat = fmt.format === 3;

    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < fmt.channels; c++) {
        const at = dataStart + (i * fmt.channels + c) * bytesPerSample;
        let v = 0;
        if (isFloat && bytesPerSample === 4) v = buf.readFloatLE(at);
        else if (bytesPerSample === 2) v = buf.readInt16LE(at) / 32768;
        else if (bytesPerSample === 3) {
          const raw = buf.readUInt8(at) | (buf.readUInt8(at + 1) << 8) | (buf.readInt8(at + 2) << 16);
          v = raw / 8388608;
        } else if (bytesPerSample === 4) v = buf.readInt32LE(at) / 2147483648;
        else if (bytesPerSample === 1) v = (buf.readUInt8(at) - 128) / 128;
        sum += v;
      }
      mono[i] = sum / fmt.channels;
    }

    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      durationSec: frameCount / fmt.sampleRate,
      samples: mono,
    };
  } catch {
    return null;
  }
}

/** Root-mean-square of a slice — the energy measure the voiced-frame gate uses. */
function rms(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/**
 * Fundamental frequency of one frame by autocorrelation.
 *
 * Autocorrelation rather than anything cleverer because it is short, has no
 * dependencies, and is entirely adequate for "roughly how low is this voice" —
 * which is all the picker claims to show. Returns null when the frame has no
 * clear periodicity (silence, breath, a consonant), so unvoiced frames drop
 * out instead of contributing noise to the median.
 */
export function frameF0(samples, from, to, sampleRate, { minHz = F0_MIN_HZ, maxHz = F0_MAX_HZ } = {}) {
  const n = to - from;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / minHz);
  if (n < maxLag * 2) return null;

  // Remove DC: a constant offset makes every lag look correlated.
  let mean = 0;
  for (let i = from; i < to; i++) mean += samples[i];
  mean /= n;

  let energy = 0;
  for (let i = from; i < to; i++) { const v = samples[i] - mean; energy += v * v; }
  if (energy <= 0) return null;

  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = from; i + lag < to; i++) corr += (samples[i] - mean) * (samples[i + lag] - mean);
    const score = corr / energy;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }

  // A periodic frame correlates strongly with itself one period along. Below
  // this the "peak" is noise wearing a pattern.
  if (bestLag < 0 || bestScore < 0.3) return null;
  return sampleRate / bestLag;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const percentileOf = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

/**
 * Measure a reference clip.
 *
 * `medianF0Hz` is the headline: the pitch around which this voice sits. The
 * 10th/90th percentiles say how much it moves — a narrow range reads as flat
 * or steady, a wide one as expressive, and for a Familiar that is arguably
 * more interesting than the pitch itself.
 *
 * `zeroCrossRate` is a cheap brightness/noisiness proxy (higher = more high-
 * frequency content: sibilance, air, crispness). Called what it is rather than
 * dressed up as "timbre", because that is what it measures.
 */
export function measureVoiceClip(buffer, { frameMs = 40, hopMs = 20 } = {}) {
  const wav = parseWav(buffer);
  if (!wav) return { ok: false, reason: 'unreadable' };

  const { samples, sampleRate, durationSec } = wav;
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));

  const overall = rms(samples, 0, samples.length);
  // Frames quieter than a fraction of the clip's own level are silence or
  // breath. Relative rather than absolute, so a quietly recorded clip is not
  // treated as entirely unvoiced.
  const voicedFloor = overall * 0.25;

  const f0s = [];
  let voicedFrames = 0;
  let totalFrames = 0;
  let crossings = 0;

  for (let start = 0; start + frame <= samples.length; start += hop) {
    totalFrames++;
    if (rms(samples, start, start + frame) < voicedFloor) continue;
    voicedFrames++;
    const f0 = frameF0(samples, start, start + frame, sampleRate);
    if (f0) f0s.push(f0);
  }

  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  }

  return {
    ok: true,
    durationSec: Number(durationSec.toFixed(2)),
    sampleRate,
    channels: wav.channels,
    medianF0Hz: f0s.length ? Math.round(median(f0s)) : null,
    f0LowHz: f0s.length ? Math.round(percentileOf(f0s, 10)) : null,
    f0HighHz: f0s.length ? Math.round(percentileOf(f0s, 90)) : null,
    // How much of the clip is actually someone speaking, rather than room.
    voicedFraction: totalFrames ? Number((voicedFrames / totalFrames).toFixed(2)) : 0,
    // Confidence in the pitch figure: few voiced frames, weak number.
    pitchSamples: f0s.length,
    zeroCrossRate: samples.length > 1 ? Number((crossings / (samples.length / sampleRate)).toFixed(0)) : 0,
    levelDb: overall > 0 ? Number((20 * Math.log10(overall)).toFixed(1)) : null,
  };
}

/**
 * A plain-language sentence for the picker — describing the MEASUREMENT, never
 * the person.
 *
 * "Lower-pitched" is a fact about hertz. "A man's voice" would be a guess
 * about someone who donated their voice on the understanding it would be used,
 * not categorised. The distinction matters and the wording keeps it.
 */
export function describeMeasurement(f) {
  if (!f?.ok || f.medianF0Hz == null) return 'Pitch could not be measured from this clip.';
  const p = f.medianF0Hz;
  const band = p < 130 ? 'low' : p < 165 ? 'low-to-mid' : p < 200 ? 'mid' : p < 240 ? 'mid-to-high' : 'high';
  const spread = (f.f0HighHz != null && f.f0LowHz != null) ? f.f0HighHz - f.f0LowHz : null;
  const movement = spread == null ? '' : spread < 40 ? ', fairly steady' : spread > 110 ? ', moves around a lot' : '';
  const weak = f.pitchSamples < 10 ? ' (measured from very little speech — worth a listen)' : '';
  return `${band} pitch, around ${p} Hz${movement}${weak}.`;
}
