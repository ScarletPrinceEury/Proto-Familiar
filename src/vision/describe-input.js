/**
 * describe-input.js — the copy of an image a describer is handed (0.14.123).
 *
 * The describe path used to send the stored bytes as they were. Two things went
 * wrong with that on the z.ai coding-plan describer (its Vision MCP):
 *   - it takes only JPG and PNG, up to 5 MB, and turns everything else away
 *     ("Unsupported image format"), so a WebP screenshot was never described;
 *   - a 2–3 MB PNG render took 30 s to two minutes to describe, longer than a
 *     turn waits, so I answered pictures I hadn't seen yet.
 *
 * So every describe gets its own copy: a JPG or PNG that's already small goes as
 * it is (a small PNG screenshot keeps its crisp text), anything else becomes a
 * JPEG at the same pixel size (the 1568 long edge the store already caps to).
 * The stored image is never touched; only what the describer reads changes.
 *
 * The converter is `sharp`, loaded lazily. An install where it didn't install
 * (or fails to load) still runs: the stored bytes go as they are, exactly as
 * before, and a describer that can't take them says so (see `zaiRefusal`).
 */

export const DESCRIBE_EDGE = 1568;
// A JPG/PNG at or under this goes to the describer untouched.
export const KEEP_AS_IS_BYTES = 1_000_000;
const JPEG_QUALITY = 85;

// What z.ai's Vision MCP takes (read from its installed source, file-service.js:
// supportedExts ['.jpg', '.jpeg', '.png'], MAX_IMAGE_SIZE_MB 5).
export const ZAI_MIMES = new Set(['image/jpeg', 'image/png']);
export const ZAI_MAX_BYTES = 5 * 1024 * 1024;

const PLAIN_MIMES = new Set(['image/jpeg', 'image/png']);

let _sharp;          // undefined = not tried yet, null = unavailable
let _sharpLoading = null;

/** The sharp module, or null when it isn't installed or won't load. Never throws. */
export async function loadSharp() {
  if (_sharp !== undefined) return _sharp;
  if (!_sharpLoading) {
    _sharpLoading = import('sharp')
      .then((m) => { _sharp = m?.default ?? m ?? null; return _sharp; })
      .catch((err) => {
        console.warn(`[vision] image converter (sharp) unavailable — describes get the stored bytes as they are: ${err?.message ?? err}`);
        _sharp = null;
        return null;
      });
  }
  return _sharpLoading;
}

/**
 * The copy to describe. Returns `{ buffer, mime, converted }` plus `from` (the
 * original mime) when converted, or `note` when it wanted to convert and
 * couldn't. Never throws; on any trouble the original goes as it is.
 *
 * @param {{buffer: Buffer, mime: string}} image
 * @param {{loadConverter?: () => Promise<any>}} [opts]  injectable for tests
 */
export async function prepareDescribeInput({ buffer, mime } = {}, { loadConverter = loadSharp } = {}) {
  const asIs = { buffer, mime, converted: false };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return asIs;
  const plain = PLAIN_MIMES.has(mime);
  if (plain && buffer.length <= KEEP_AS_IS_BYTES) return asIs;
  const sharp = await loadConverter();
  if (!sharp) return { ...asIs, note: 'no-converter' };
  try {
    const out = await sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width: DESCRIBE_EDGE, height: DESCRIBE_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    // A plain image the JPEG didn't shrink goes as it is.
    if (plain && out.length >= buffer.length) return asIs;
    return { buffer: out, mime: 'image/jpeg', converted: true, from: mime };
  } catch (err) {
    return { ...asIs, note: `convert-failed: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

/** Why z.ai's describer would turn this copy away, or null when it takes it. */
export function zaiRefusal({ buffer, mime } = {}) {
  if (!ZAI_MIMES.has(mime)) return 'format';
  if (Buffer.isBuffer(buffer) && buffer.length > ZAI_MAX_BYTES) return 'too-big';
  return null;
}

/** Whether a describer error message is about the file itself (format/size). */
export function isImageFileRefusal(text) {
  return /unsupported image format|image (format|size)|too large|exceeds? .*(size|mb)|图片输入格式|解析错误/i.test(String(text ?? ''));
}

/** For tests: forget the cached converter so the next load tries again. */
export function __resetConverterForTest() { _sharp = undefined; _sharpLoading = null; }
