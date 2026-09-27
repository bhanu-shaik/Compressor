/* ==========================================================================
   compressor.js — dependency-free, local-only image compression engine.
   --------------------------------------------------------------------------
   Nothing in this file performs a network request. Image bytes arrive as a
   File/Blob handle created by the browser's own file picker, are processed with
   Canvas + typed arrays, and are returned as a Blob. There is no fetch(), no
   XMLHttpRequest, no WebSocket, no FormData and no <form> upload anywhere.

   Written as a classic script (not an ES module) so one source works in two
   places:
     • main thread  — <script src="js/compressor.js">
     • Web Worker   — importScripts('compressor.js')
   ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.ImageCompressor = api; }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================================
     1. Constants
     ====================================================================== */

  /** Accepted input MIME types, mapped to a canonical format id. */
  var INPUT_MIME = {
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/pjpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp'
  };

  var MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var EXT_BY_FORMAT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
  var LABEL_BY_FORMAT = { jpeg: 'JPG', png: 'PNG', webp: 'WebP' };

  /* Safety limits. They only warn or refuse — they never silently change the
     image. Dimensions change only when the user asks for it. */
  var MAX_INPUT_BYTES = 512 * 1024 * 1024;
  var WARN_INPUT_BYTES = 20 * 1024 * 1024;
  var WARN_PIXELS = 16 * 1000 * 1000;
  var MAX_PIXELS = 80 * 1000 * 1000;
  var MAX_CANVAS_EDGE = 16384;

  /* Quality floors for target-size mode: below these the result is no longer a
     useful image, so the search stops and the UI explains the situation. */
  var MIN_TARGET_QUALITY = 0.30;
  var MIN_TARGET_COLORS = 16;

  /* Maximum encoder calls inside a target-size search. */
  var SEARCH_STEPS = 7;

  /* Histogram geometry: 5 bits per channel, so r5<<15 | g5<<10 | b5<<5 | a5. */
  var HIST_BITS = 20;
  var HIST_SIZE = 1 << HIST_BITS;
  var GRID_SIZE = 1 << 15;            // 32,768 cells: the 5-bit RGB space

  /* When a palette is refined for an image with transparency, only a bounded
     sample of buckets is re-assigned, because alpha-aware nearest-colour search
     cannot use the shared RGB grid. */
  var REFINE_SAMPLE_LIMIT = 80000;

  /* ======================================================================
     2. Errors — every user-visible failure is one of these
     ====================================================================== */

  /**
   * `cause` is attached non-enumerably so a wrapped low-level failure stays
   * debuggable from the console while never reaching the person using the tool.
   */
  function makeError(code, message, cause) {
    var err = new Error(message);
    err.name = 'CompressError';
    err.code = code;
    if (cause) {
      try { Object.defineProperty(err, 'cause', { value: cause, configurable: true }); }
      catch (ignored) { /* environments without defineProperty */ }
    }
    return err;
  }

  function fail(code, message) { throw makeError(code, message); }

  function asCompressError(err, fallbackCode, fallbackMessage) {
    return (err && err.name === 'CompressError')
      ? err
      : makeError(fallbackCode, fallbackMessage, err);
  }

  /* ======================================================================
     3. Helpers
     ====================================================================== */

  function isSupportedMime(mime) {
    return Object.prototype.hasOwnProperty.call(INPUT_MIME, String(mime || '').toLowerCase());
  }

  function formatOfMime(mime) {
    var key = String(mime || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(INPUT_MIME, key) ? INPUT_MIME[key] : null;
  }

  /** Human-readable size using decimal units, like most file managers. */
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) { return '—'; }
    if (bytes < 1000) { return bytes + ' B'; }
    var units = ['KB', 'MB', 'GB'];
    var value = bytes / 1000;
    var i = 0;
    while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
    return value.toFixed(value >= 100 ? 0 : (value >= 10 ? 1 : 2)) + ' ' + units[i];
  }

  function clamp(value, min, max) { return value < min ? min : (value > max ? max : value); }

  function report(options, phase, percent) {
    if (typeof options.onProgress === 'function') {
      try { options.onProgress(phase, percent); } catch (ignored) { /* never break a run */ }
    }
  }

  /* ======================================================================
     4. CRC-32 and Adler-32 (PNG chunks, ZIP entries)
     ====================================================================== */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) { c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    var a = 1, b = 0;
    for (var i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /* ======================================================================
     5. zlib wrapper for the bytes of a PNG image data stream
     ----------------------------------------------------------------------
     Preferred path is the browser's native CompressionStream. The fallback
     emits a valid "stored" (uncompressed) deflate stream, which every PNG
     decoder accepts — the file is simply larger.
     ====================================================================== */

  function storedZlib(bytes) {
    var MAX_BLOCK = 65535;
    var blocks = Math.max(1, Math.ceil(bytes.length / MAX_BLOCK));
    var out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
    var p = 0;
    out[p++] = 0x78;                        // CMF: deflate, 32K window
    out[p++] = 0x01;                        // FLG: no preset dictionary
    var offset = 0;
    for (var i = 0; i < blocks; i++) {
      var len = Math.min(MAX_BLOCK, bytes.length - offset);
      out[p++] = (i === blocks - 1) ? 1 : 0;
      out[p++] = len & 0xff;
      out[p++] = (len >>> 8) & 0xff;
      out[p++] = (~len) & 0xff;
      out[p++] = ((~len) >>> 8) & 0xff;
      out.set(bytes.subarray(offset, offset + len), p);
      p += len;
      offset += len;
    }
    var sum = adler32(bytes);
    out[p++] = (sum >>> 24) & 0xff;
    out[p++] = (sum >>> 16) & 0xff;
    out[p++] = (sum >>> 8) & 0xff;
    out[p++] = sum & 0xff;
    return out;
  }

  function zlibCompress(bytes) {
    if (typeof CompressionStream === 'function' && typeof Response === 'function') {
      try {
        var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
        return new Response(stream).arrayBuffer().then(function (buffer) {
          return new Uint8Array(buffer);
        }, function () {
          return storedZlib(bytes);
        });
      } catch (err) {
        /* native stream unavailable — fall through to the stored fallback */
      }
    }
    return Promise.resolve(storedZlib(bytes));
  }

  /* ======================================================================
     6. Canvas plumbing (works with OffscreenCanvas or HTMLCanvasElement)
     ====================================================================== */

  function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') { return new OffscreenCanvas(width, height); }
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function canvasToBlob(canvas, mime, quality) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: mime, quality: quality });
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) { resolve(blob); }
        else { reject(makeError('ENCODE_FAILED', 'The browser could not encode this image.')); }
      }, mime, quality);
    });
  }

  function readPixels(canvas) {
    var context = canvas.getContext('2d');
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /* ======================================================================
     7. Decoding
     ====================================================================== */

  var UNREADABLE_IMAGE = 'This file could not be read as an image. It may be damaged or incomplete.';

  function decode(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).catch(function () { return decodeViaElement(blob); });
    }
    return Promise.resolve(decodeViaElement(blob));
  }

  /* createImageBitmap is the only decoder a Web Worker has, so there is no
     <img> to fall back to there. When a worker reaches this function the bytes
     have already been refused by createImageBitmap, which means the file
     itself is at fault, and that is what the user is told. */
  function decodeViaElement(blob) {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      return Promise.reject(makeError('DECODE_FAILED', UNREADABLE_IMAGE));
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(makeError('DECODE_FAILED', UNREADABLE_IMAGE));
      };
      img.src = url;
    });
  }

  function release(decoded) {
    if (decoded && typeof decoded.close === 'function') { decoded.close(); }
  }

  /** Reads the first bytes of the Blob the browser already holds in memory to
      identify a file whose MIME type was missing or wrong. No network. */
  function sniffFormat(blob) {
    if (typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') {
      return Promise.resolve(null);
    }
    return blob.slice(0, 12).arrayBuffer().then(function (buffer) {
      var b = new Uint8Array(buffer);
      if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return 'jpeg'; }
      if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { return 'png'; }
      if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
          b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) { return 'webp'; }
      return null;
    }, function () { return null; });
  }

  function resolveSourceFormat(blob, decoded) {
    if (decoded && formatOfMime(decoded.type)) { return Promise.resolve(formatOfMime(decoded.type)); }
    if (formatOfMime(blob.type)) { return Promise.resolve(formatOfMime(blob.type)); }
    return sniffFormat(blob);
  }

  /* ======================================================================
     8. Pixel analysis
     ====================================================================== */

  /**
   * PngContext collects, in two passes over the pixels, everything the PNG
   * encoders need: a 5-bit RGBA histogram, per-bucket population and colour
   * sums, whether the image uses transparency, and whether it is greyscale.
   * Building it once means a target-size search only re-runs the cheap steps.
   */
  function PngContext(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.pixelCount = width * height;
    this.hasAlpha = false;
    this.grayOnly = true;
    this.bucketKeys = null;
    this.bucketCounts = null;
    this.sumR = this.sumG = this.sumB = this.sumA = null;
    this.lookup = null;         // histogram key → index into the arrays above
    this.exactLookup = null;    // key → palette slot, only when lossless
  }

  PngContext.prototype.analyse = function () {
    var data = this.data;
    var pixelCount = this.pixelCount;
    var hist = new Uint32Array(HIST_SIZE);
    var hasAlpha = false;
    var grayOnly = true;
    var i, p, key;

    for (i = 0, p = 0; i < pixelCount; i++, p += 4) {
      var a = data[p + 3];
      if (a !== 255) { hasAlpha = true; }
      var r = data[p], g = data[p + 1], b = data[p + 2];
      if (grayOnly && (r !== g || g !== b)) { grayOnly = false; }
      hist[((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3)]++;
    }

    var keys = [];
    for (key = 0; key < HIST_SIZE; key++) { if (hist[key] !== 0) { keys.push(key); } }
    var n = keys.length;

    this.hasAlpha = hasAlpha;
    this.grayOnly = grayOnly;
    this.bucketKeys = new Int32Array(keys);
    this.bucketCounts = new Uint32Array(n);
    this.sumR = new Float64Array(n);
    this.sumG = new Float64Array(n);
    this.sumB = new Float64Array(n);
    this.sumA = new Float64Array(n);

    /* Colour sums and populations are stored per populated bucket, so a colour
       box holding raw histogram keys has to translate them through this. */
    var lookup = new Int32Array(HIST_SIZE).fill(-1);
    for (i = 0; i < n; i++) {
      lookup[keys[i]] = i;
      this.bucketCounts[i] = hist[keys[i]];
    }
    this.lookup = lookup;

    for (i = 0, p = 0; i < pixelCount; i++, p += 4) {
      var slot = lookup[((data[p] >> 3) << 15) | ((data[p + 1] >> 3) << 10) |
                       ((data[p + 2] >> 3) << 5) | (data[p + 3] >> 3)];
      this.sumR[slot] += data[p];
      this.sumG[slot] += data[p + 1];
      this.sumB[slot] += data[p + 2];
      this.sumA[slot] += data[p + 3];
    }
    return this;
  };

  /** Average colour of one histogram bucket, as RGBA. */
  PngContext.prototype.bucketColour = function (slot, out, offset) {
    var weight = this.bucketCounts[slot] || 1;
    out[offset] = clamp(Math.round(this.sumR[slot] / weight), 0, 255);
    out[offset + 1] = clamp(Math.round(this.sumG[slot] / weight), 0, 255);
    out[offset + 2] = clamp(Math.round(this.sumB[slot] / weight), 0, 255);
    out[offset + 3] = clamp(Math.round(this.sumA[slot] / weight), 0, 255);
  };

  /* ======================================================================
     9. Median-cut palette construction
     ====================================================================== */

  /**
   * A colour box holds the histogram buckets inside it. Because the axis is
   * quantised to 5 bits, splitting groups items into 32 value buckets instead
   * of sorting them, so every split is O(buckets in the box).
   */
  function makeBox(ctx, items) {
    var box = {
      items: items, count: 0,
      rMin: 31, rMax: 0, gMin: 31, gMax: 0, bMin: 31, bMax: 0, aMin: 31, aMax: 0
    };
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      var key = items[i];
      var r = (key >> 15) & 31, g = (key >> 10) & 31, b = (key >> 5) & 31, a = key & 31;
      if (r < box.rMin) box.rMin = r;
      if (r > box.rMax) box.rMax = r;
      if (g < box.gMin) box.gMin = g;
      if (g > box.gMax) box.gMax = g;
      if (b < box.bMin) box.bMin = b;
      if (b > box.bMax) box.bMax = b;
      if (a < box.aMin) box.aMin = a;
      if (a > box.aMax) box.aMax = a;
      total += ctx.bucketCounts[ctx.lookup[key]];
    }
    box.count = total;
    return box;
  }

  function widestAxis(box) {
    var spans = [
      box.rMax - box.rMin,
      box.gMax - box.gMin,
      box.bMax - box.bMin,
      (box.aMax - box.aMin) * 2       // alpha is half as important as colour
    ];
    var best = 0;
    for (var s = 1; s < 4; s++) { if (spans[s] > spans[best]) { best = s; } }
    return best;
  }

  function axisValue(key, axis) {
    if (axis === 0) { return (key >> 15) & 31; }
    if (axis === 1) { return (key >> 10) & 31; }
    if (axis === 2) { return (key >> 5) & 31; }
    return key & 31;
  }

  function splitBox(ctx, boxes, index) {
    var box = boxes[index];
    var axis = widestAxis(box);
    var items = box.items;

    /* Two views of the same axis. The split point has to be chosen by pixel
       population, so a heavy region does not get the same weight as a sparse
       one; the two output arrays are sized in buckets. */
    var population = new Uint32Array(32);
    var bucketsPerValue = new Uint32Array(32);
    for (var i = 0; i < items.length; i++) {
      var value = axisValue(items[i], axis);
      bucketsPerValue[value]++;
      population[value] += ctx.bucketCounts[ctx.lookup[items[i]]];
    }

    // Threshold where the cumulative population passes half of the box.
    var threshold = 0, running = 0, half = box.count / 2;
    for (; threshold < 31; threshold++) {
      running += population[threshold];
      if (running >= half) { break; }
    }
    var above = 0, v;
    for (v = threshold + 1; v < 32; v++) { above += population[v]; }
    if (above === 0) { threshold--; }        // keep both halves non-empty
    if (threshold < 0) { return null; }

    var leftSize = 0, rightSize = 0;
    for (v = 0; v <= threshold; v++) { leftSize += bucketsPerValue[v]; }
    for (v = threshold + 1; v < 32; v++) { rightSize += bucketsPerValue[v]; }
    if (leftSize === 0 || rightSize === 0) { return null; }

    var left = new Int32Array(leftSize);
    var right = new Int32Array(rightSize);
    var li = 0, ri = 0;
    for (i = 0; i < items.length; i++) {
      if (axisValue(items[i], axis) <= threshold) { left[li++] = items[i]; }
      else { right[ri++] = items[i]; }
    }
    return [makeBox(ctx, left), makeBox(ctx, right)];
  }

  /**
   * Builds an RGBA palette of at most `maxColors` entries.
   *   phase 1 — median cut over the populated histogram buckets
   *   phase 2 — a few Lloyd refinement passes, so palette entries become real
   *             weighted averages rather than bucket centres
   * Returns { palette, count, grid, exact } where `grid` is a 32,768-cell
   * nearest-colour table for opaque palettes, and `exact` marks the lossless
   * case where no searching is needed at all.
   */
  function buildPalette(ctx, maxColors, useAlpha) {
    var n = ctx.bucketKeys.length;
    var palette = new Uint8Array(Math.max(1, maxColors) * 4);
    var i, slots;
    ctx.exactLookup = null;

    /* Lossless case: the image already fits inside the palette budget, so keep
       every colour. Mapping becomes a single table lookup per pixel. */
    if (n <= maxColors) {
      for (i = 0; i < n; i++) { ctx.bucketColour(i, palette, i * 4); }
      if (n === 0) { palette[3] = 255; }
      ctx.exactLookup = new Int32Array(HIST_SIZE).fill(-1);
      for (i = 0; i < n; i++) { ctx.exactLookup[ctx.bucketKeys[i]] = i; }
      return { palette: palette, count: Math.max(n, 1), grid: null, exact: true };
    }

    /* Seed one entry per median-cut box. */
    var boxes = [makeBox(ctx, ctx.bucketKeys)];
    while (boxes.length < maxColors) {
      var best = -1, bestCount = 0;
      for (var b = 0; b < boxes.length; b++) {
        if (boxes[b].items.length < 2) { continue; }
        if (boxes[b].count > bestCount) { bestCount = boxes[b].count; best = b; }
      }
      if (best < 0) { break; }
      var parts = splitBox(ctx, boxes, best);
      if (!parts) { break; }
      boxes.splice(best, 1, parts[0], parts[1]);
    }

    var used = boxes.length;
    for (i = 0; i < used; i++) {
      var items = boxes[i].items;
      var accR = 0, accG = 0, accB = 0, accA = 0;
      for (var t = 0; t < items.length; t++) {
        var slot = ctx.lookup[items[t]];
        accR += ctx.sumR[slot]; accG += ctx.sumG[slot];
        accB += ctx.sumB[slot]; accA += ctx.sumA[slot];
      }
      var weight = boxes[i].count || 1;
      var o = i * 4;
      palette[o] = clamp(Math.round(accR / weight), 0, 255);
      palette[o + 1] = clamp(Math.round(accG / weight), 0, 255);
      palette[o + 2] = clamp(Math.round(accB / weight), 0, 255);
      palette[o + 3] = clamp(Math.round(accA / weight), 0, 255);
    }

    /* Lloyd refinement. Opaque palettes use the shared RGB grid; palettes with
       transparency fall back to a bounded sample of direct searches. */
    var passes = n > 20000 ? 2 : 3;
    var grid = useAlpha ? null : buildNearestGrid(palette, used);
    for (var pass = 0; pass < passes; pass++) {
      slots = refinePalette(ctx, palette, used, grid, useAlpha);
      if (slots < used) { used = slots; }
      if (!useAlpha) { grid = buildNearestGrid(palette, used); }
    }
    return { palette: palette, count: used, grid: grid, exact: false };
  }

  /** For every 5-bit RGB cell, the index of the closest opaque palette entry. */
  function buildNearestGrid(palette, paletteCount) {
    var grid = new Uint16Array(GRID_SIZE);
    for (var cell = 0; cell < GRID_SIZE; cell++) {
      grid[cell] = nearestPalette(palette, paletteCount,
        ((cell >> 10) & 31) * 8 + 4,
        ((cell >> 5) & 31) * 8 + 4,
        (cell & 31) * 8 + 4,
        255, false);
    }
    return grid;
  }

  function nearestPalette(palette, paletteCount, r, g, b, a, useAlpha) {
    var best = 0, bestDistance = Infinity;
    for (var i = 0; i < paletteCount; i++) {
      var o = i * 4;
      var dr = palette[o] - r, dg = palette[o + 1] - g, db = palette[o + 2] - b;
      var distance = dr * dr + dg * dg + db * db;
      if (useAlpha) { var da = palette[o + 3] - a; distance += da * da * 9; }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
        if (distance === 0) { break; }
      }
    }
    return best;
  }

  /**
   * One Lloyd iteration: assign every considered bucket to its closest palette
   * entry, then move each entry to the average colour of its members. Empty
   * entries are dropped and the palette compacted.
   */
  function refinePalette(ctx, palette, paletteCount, grid, useAlpha) {
    var keys = ctx.bucketKeys;
    var n = keys.length;
    var stride = useAlpha ? Math.max(1, Math.ceil(n / REFINE_SAMPLE_LIMIT)) : 1;
    var accR = new Float64Array(paletteCount);
    var accG = new Float64Array(paletteCount);
    var accB = new Float64Array(paletteCount);
    var accA = new Float64Array(paletteCount);
    var accW = new Float64Array(paletteCount);
    var i, slot, key;

    for (i = 0; i < n; i += stride) {
      key = keys[i];
      if (useAlpha) {
        slot = nearestPalette(palette, paletteCount,
          ((key >> 15) & 31) * 8 + 4,
          ((key >> 10) & 31) * 8 + 4,
          ((key >> 5) & 31) * 8 + 4,
          (key & 31) * 8 + 4, true);
      } else {
        slot = grid[(key >> 5) & (GRID_SIZE - 1)];
      }
      accR[slot] += ctx.sumR[i]; accG[slot] += ctx.sumG[i];
      accB[slot] += ctx.sumB[i]; accA[slot] += ctx.sumA[i];
      accW[slot] += ctx.bucketCounts[i];
    }

    var next = 0;
    for (var j = 0; j < paletteCount; j++) {
      if (accW[j] === 0) { continue; }
      var from = j * 4, to = next * 4;
      palette[to] = clamp(Math.round(accR[j] / accW[j]), 0, 255);
      palette[to + 1] = clamp(Math.round(accG[j] / accW[j]), 0, 255);
      palette[to + 2] = clamp(Math.round(accB[j] / accW[j]), 0, 255);
      palette[to + 3] = clamp(Math.round(accA[j] / accW[j]), 0, 255);
      next++;
    }
    return next === 0 ? 1 : next;
  }

  /* ======================================================================
     10. Pixel → palette index mapping
     ====================================================================== */

  function bucketKey(r, g, b, a) {
    return ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
  }

  function mapExact(ctx, pixelCount) {
    var data = ctx.data;
    var lookup = ctx.exactLookup;
    var indices = new Uint8Array(pixelCount);
    for (var i = 0, p = 0; i < pixelCount; i++, p += 4) {
      indices[i] = lookup[bucketKey(data[p], data[p + 1], data[p + 2], data[p + 3])];
    }
    return indices;
  }

  function mapWithGrid(ctx, pixelCount, grid) {
    var data = ctx.data;
    var indices = new Uint8Array(pixelCount);
    for (var i = 0, p = 0; i < pixelCount; i++, p += 4) {
      indices[i] = grid[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)];
    }
    return indices;
  }

  function mapWithSearch(ctx, pixelCount, palette, paletteCount) {
    var data = ctx.data;
    var indices = new Uint8Array(pixelCount);
    // One 20-bit RGBA table replaces repeated nearest-colour searches.
    var cache = new Int16Array(HIST_SIZE).fill(-1);
    for (var i = 0, p = 0; i < pixelCount; i++, p += 4) {
      var r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
      var key = bucketKey(r, g, b, a);
      var hit = cache[key];
      if (hit < 0) {
        hit = nearestPalette(palette, paletteCount, r, g, b, a, true);
        cache[key] = hit;
      }
      indices[i] = hit;
    }
    return indices;
  }

  /**
   * Floyd–Steinberg error diffusion over RGB. Diffusing turns colour banding
   * into fine noise, which looks considerably better at small palette sizes.
   * Alpha is never dithered, so transparency stays exactly as authored.
   */
  function mapDithered(ctx, palette, paletteCount, useAlpha) {
    var data = ctx.data;
    var width = ctx.width;
    var height = ctx.height;
    var pixelCount = ctx.pixelCount;
    var indices = new Uint8Array(pixelCount);
    var stride = width + 2;
    var current = new Float32Array(stride * 3);
    var next = new Float32Array(stride * 3);
    var grid = useAlpha ? null : buildNearestGrid(palette, paletteCount);
    var cache = useAlpha ? new Int16Array(HIST_SIZE).fill(-1) : null;
    var p = 0, x, y, e, r, g, b, a, index, o, er, eg, eb;

    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++, p += 4) {
        e = (x + 1) * 3;
        r = data[p] + current[e];
        g = data[p + 1] + current[e + 1];
        b = data[p + 2] + current[e + 2];
        r = r < 0 ? 0 : (r > 255 ? 255 : r);
        g = g < 0 ? 0 : (g > 255 ? 255 : g);
        b = b < 0 ? 0 : (b > 255 ? 255 : b);
        a = data[p + 3];

        if (grid) {
          index = grid[((r | 0) >> 3) << 10 | (((g | 0) >> 3) << 5) | ((b | 0) >> 3)];
        } else {
          var key = bucketKey(r | 0, g | 0, b | 0, a);
          index = cache[key];
          if (index < 0) {
            index = nearestPalette(palette, paletteCount, r | 0, g | 0, b | 0, a, true);
            cache[key] = index;
          }
        }
        indices[y * width + x] = index;

        o = index * 4;
        er = r - palette[o];
        eg = g - palette[o + 1];
        eb = b - palette[o + 2];

        next[e] += er * 0.4375; next[e + 1] += eg * 0.4375; next[e + 2] += eb * 0.4375;
        current[e - 3] += er * 0.1875; current[e - 2] += eg * 0.1875; current[e - 1] += eb * 0.1875;
        next[e - 3] += er * 0.1875; next[e - 2] += eg * 0.1875; next[e - 1] += eb * 0.1875;
        next[e + 3] += er * 0.3125; next[e + 4] += eg * 0.3125; next[e + 5] += eb * 0.3125;
        next[e + 6] += er * 0.0625; next[e + 7] += eg * 0.0625; next[e + 8] += eb * 0.0625;
      }
      var swap = current;
      current = next;
      next = swap;
      next.fill(0);
    }
    return indices;
  }

  /* ======================================================================
     11. PNG scanline filtering and assembly
     ====================================================================== */

  function absSigned(v) { return v < 128 ? v : 256 - v; }

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) { return a; }
    return pb <= pc ? b : c;
  }

  /**
   * Applies all five PNG filters to each row and keeps the one with the lowest
   * sum of absolute differences — the heuristic libpng uses. For bit depths
   * below 8, filtering operates on whole bytes, which is what the PNG spec
   * requires (bytes per pixel = 1).
   */
  function filterScanlines(samples, width, height, bitDepth) {
    var rowBytes = Math.ceil(width * bitDepth / 8);
    var out = new Uint8Array((rowBytes + 1) * height);
    var buffers = [
      new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes),
      new Uint8Array(rowBytes), new Uint8Array(rowBytes)
    ];

    for (var y = 0; y < height; y++) {
      var src = y * rowBytes;
      var dst = y * (rowBytes + 1);
      var prev = (y - 1) * rowBytes;
      var scores = [0, 0, 0, 0, 0];

      for (var x = 0; x < rowBytes; x++) {
        var raw = samples[src + x];
        var left = x >= 1 ? samples[src + x - 1] : 0;
        var up = y > 0 ? samples[prev + x] : 0;
        var upLeft = (x >= 1 && y > 0) ? samples[prev + x - 1] : 0;

        var v0 = raw;
        var v1 = (raw - left) & 0xff;
        var v2 = (raw - up) & 0xff;
        var v3 = (raw - ((left + up) >> 1)) & 0xff;
        var v4 = (raw - paeth(left, up, upLeft)) & 0xff;

        buffers[0][x] = v0; buffers[1][x] = v1; buffers[2][x] = v2;
        buffers[3][x] = v3; buffers[4][x] = v4;

        scores[0] += absSigned(v0);
        scores[1] += absSigned(v1);
        scores[2] += absSigned(v2);
        scores[3] += absSigned(v3);
        scores[4] += absSigned(v4);
      }

      var best = 0;
      for (var f = 1; f < 5; f++) { if (scores[f] < scores[best]) { best = f; } }
      out[dst] = best;
      out.set(buffers[best], dst + 1);
    }
    return out;
  }

  function packBits(samples, bitDepth) {
    var perByte = 8 / bitDepth;
    var out = new Uint8Array(Math.ceil(samples.length / perByte));
    var mask = (1 << bitDepth) - 1;
    for (var i = 0; i < samples.length; i++) {
      out[(i / perByte) | 0] |= (samples[i] & mask) << (8 - bitDepth * ((i % perByte) + 1));
    }
    return out;
  }

  function pngChunk(type, payload) {
    var out = new Uint8Array(payload.length + 12);
    var view = new DataView(out.buffer);
    view.setUint32(0, payload.length);
    for (var i = 0; i < 4; i++) { out[4 + i] = type.charCodeAt(i); }
    out.set(payload, 8);
    view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
    return out;
  }

  function assemblePng(width, height, bitDepth, colorType, extraChunks, deflated) {
    var ihdr = new Uint8Array(13);
    var ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    ihdr[10] = 0;      // compression method: deflate
    ihdr[11] = 0;      // filter method: adaptive
    ihdr[12] = 0;      // interlace: none

    var chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)];
    for (var i = 0; i < extraChunks.length; i++) { chunks.push(extraChunks[i]); }
    chunks.push(pngChunk('IDAT', deflated));
    chunks.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob(chunks, { type: 'image/png' });
  }

  /* ======================================================================
     12. PNG encoders
     ====================================================================== */

  /**
   * Lossless greyscale (PNG colour type 0). Used only when every grey level in
   * the image is exactly representable at 1, 2 or 4 bits, in which case the
   * result carries the same tones as the original and is usually far smaller.
   * Depths are tried smallest first, so the tightest lossless encoding wins.
   */
  function encodeGreyscale(ctx, options) {
    if (ctx.hasAlpha || !ctx.grayOnly) { return Promise.resolve(null); }
    var data = ctx.data;
    var pixelCount = ctx.pixelCount;
    var depths = [1, 2, 4, 8];

    for (var d = 0; d < depths.length; d++) {
      var depth = depths[d];
      var levels = (1 << depth) - 1;
      var samples = new Uint8Array(pixelCount);
      var lossless = true;

      for (var i = 0, p = 0; i < pixelCount; i++, p += 4) {
        var value = data[p];
        var scaled = Math.round(value * levels / 255);
        if (Math.abs(scaled / levels * 255 - value) > 0.5) { lossless = false; break; }
        samples[i] = scaled;
      }
      if (!lossless) { continue; }

      var packed = depth < 8 ? packBits(samples, depth) : samples;
      var filtered = filterScanlines(packed, ctx.width, ctx.height, depth);
      report(options, 'encoding', 78);
      return zlibCompress(filtered).then(function (deflated) {
        return {
          blob: assemblePng(ctx.width, ctx.height, depth, 0, [], deflated),
          paletteSize: 0,
          detail: 'Greyscale, ' + depth + '-bit (no colour loss)'
        };
      });
    }
    return Promise.resolve(null);
  }

  /**
   * Indexed-colour PNG (colour type 3) built from a median-cut palette.
   * `maxColors` is the parameter that actually drives PNG file size, so it is
   * also the knob the target-size search turns.
   */
  function encodeIndexed(ctx, maxColors, options) {
    var built = buildPalette(ctx, maxColors, ctx.hasAlpha);
    var palette = built.palette;
    var paletteCount = built.count;
    var useAlpha = paletteUsesAlpha(palette, paletteCount);

    report(options, 'mapping', 82);
    var indices;
    if (built.exact) {
      indices = mapExact(ctx, ctx.pixelCount);
    } else if (maxColors <= 64) {
      indices = mapDithered(ctx, palette, paletteCount, useAlpha);
    } else if (useAlpha) {
      indices = mapWithSearch(ctx, ctx.pixelCount, palette, paletteCount);
    } else {
      indices = mapWithGrid(ctx, ctx.pixelCount, built.grid);
    }

    var plte = new Uint8Array(paletteCount * 3);
    var trns = useAlpha ? new Uint8Array(paletteCount) : null;
    var anyTransparent = false;
    for (var i = 0; i < paletteCount; i++) {
      plte[i * 3] = palette[i * 4];
      plte[i * 3 + 1] = palette[i * 4 + 1];
      plte[i * 3 + 2] = palette[i * 4 + 2];
      if (trns) {
        trns[i] = palette[i * 4 + 3];
        if (trns[i] !== 255) { anyTransparent = true; }
      }
    }

    var extra = [pngChunk('PLTE', plte)];
    if (trns && anyTransparent) { extra.push(pngChunk('tRNS', trns)); }

    report(options, 'encoding', 90);
    var filtered = filterScanlines(indices, ctx.width, ctx.height, 8);
    return zlibCompress(filtered).then(function (deflated) {
      var dithered = !built.exact && maxColors <= 64;
      return {
        blob: assemblePng(ctx.width, ctx.height, 8, 3, extra, deflated),
        paletteSize: paletteCount,
        detail: paletteCount + (paletteCount === 1 ? ' colour' : ' colours') +
                (dithered ? ', dithered' : '') +
                (built.exact ? ' (no colour loss)' : '')
      };
    });
  }

  function paletteUsesAlpha(palette, paletteCount) {
    for (var i = 0; i < paletteCount; i++) {
      if (palette[i * 4 + 3] !== 255) { return true; }
    }
    return false;
  }

  /**
   * PNG has no lossy quality knob, so the user's 0..1 quality is mapped onto the
   * size of the colour palette — the parameter that genuinely controls PNG file
   * size. The UI explains this instead of pretending the slider is a JPEG-style
   * quality control.
   */
  function colorsForQuality(quality) {
    return clamp(Math.round(Math.pow(2, 2 + 6 * clamp(quality, 0.1, 1))), 4, 256);
  }

  /** Inverse of colorsForQuality, so a palette size is still reported as a
      quality on the same 0..1 scale as every other result. */
  function qualityForColors(colors) {
    return clamp(Math.log(Math.max(1, colors)) / Math.LN2 / 6 - 1 / 3, 0.1, 1);
  }

  /* Palette sizes tried by target-size mode, richest first. */
  var PALETTE_LADDER = [256, 224, 192, 160, 128, 112, 96, 80, 64, 48, 40, 32, 24, 16];

  /* ======================================================================
     13. Canvas drawing
     ====================================================================== */

  function prepareContext(context) {
    if (!context) { fail('UNSUPPORTED_BROWSER', 'This browser does not support the 2D canvas API.'); }
    context.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in context) { context.imageSmoothingQuality = 'high'; }
    return context;
  }

  /** Straight draw, preserving transparency (PNG and WebP output). */
  function drawToCanvas(decoded, width, height, willReadFrequently) {
    var canvas = createCanvas(width, height);
    var context = prepareContext(
      canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined));
    context.clearRect(0, 0, width, height);
    context.drawImage(decoded, 0, 0, width, height);
    return canvas;
  }

  /**
   * JPG has no alpha channel. The image is drawn once, its transparency is
   * measured, and only then composited onto white with `destination-over` so
   * transparent areas become white rather than the black a browser would
   * otherwise substitute. The measurement has to happen before the composite,
   * which is why this is separate from drawToCanvas().
   */
  function prepareJpegCanvas(decoded, width, height) {
    var canvas = createCanvas(width, height);
    var context = prepareContext(canvas.getContext('2d', { willReadFrequently: true }));
    context.clearRect(0, 0, width, height);
    context.drawImage(decoded, 0, 0, width, height);

    var data = context.getImageData(0, 0, width, height).data;
    var pixelCount = width * height;
    var hadAlpha = false;
    for (var p = 3, i = 0; i < pixelCount; i++, p += 4) {
      if (data[p] !== 255) { hadAlpha = true; break; }
    }

    if (hadAlpha) {
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
    }
    return { canvas: canvas, hadAlpha: hadAlpha };
  }

  /* ======================================================================
     14. Public entry point
     ====================================================================== */

  function normalizeOptions(userOptions) {
    var options = {
      quality: 0.8,
      outputFormat: 'keep',
      targetBytes: null,
      maxDimension: 0,
      onProgress: null
    };
    if (userOptions) {
      for (var key in userOptions) {
        if (Object.prototype.hasOwnProperty.call(userOptions, key)) { options[key] = userOptions[key]; }
      }
    }
    options.quality = clamp(Number(options.quality) || 0.8, 0.1, 1);
    options.maxDimension = Math.max(0, Number(options.maxDimension) || 0);
    options.targetBytes = options.targetBytes > 0 ? Math.floor(options.targetBytes) : null;
    return options;
  }

  function resolveOutputFormat(requested, sourceFormat) {
    if (requested === 'jpeg' || requested === 'png' || requested === 'webp') { return requested; }
    return sourceFormat;
  }

  /**
   * Compresses one image entirely on the local device.
   *
   * Resolves with { blob, sourceBytes, outputBytes, sourceFormat, outputFormat,
   * width, height, originalWidth, originalHeight, resized, quality, detail,
   * iterations, hasAlpha, flattened, targetBytes, targetReached, significantLoss }
   */
  function compress(blob, userOptions) {
    var options = normalizeOptions(userOptions);

    if (!blob || typeof blob.size !== 'number') {
      return Promise.reject(makeError('NO_FILE', 'No image was provided.'));
    }
    if (blob.size === 0) {
      return Promise.reject(makeError('EMPTY_FILE',
        'This file is empty (0 bytes). Please choose a different image.'));
    }
    if (blob.size > MAX_INPUT_BYTES) {
      return Promise.reject(makeError('FILE_TOO_LARGE',
        'This file is larger than 512 MB, which is more than a browser tab can handle safely.'));
    }

    report(options, 'decoding', 8);
    var decoded = null;

    /* Phase 1 — read the file and decide what is going to be produced. Failures
       here are all about the input, so they are reported as read problems. */
    var plan;
    return decode(blob).then(function (image) {
      decoded = image;
      return resolveSourceFormat(blob, image);
    }).then(function (sourceFormat) {
      var originalWidth = decoded.width | 0;
      var originalHeight = decoded.height | 0;
      if (!originalWidth || !originalHeight) {
        fail('DECODE_FAILED', 'This image has no readable dimensions, so it cannot be processed.');
      }
      if (originalWidth * originalHeight > MAX_PIXELS) {
        fail('TOO_MANY_PIXELS',
          'This image is about ' + Math.round(originalWidth * originalHeight / 1e6) +
          ' megapixels. That needs more memory than a browser tab can safely use, ' +
          'so please resize it before compressing.');
      }
      if (Math.max(originalWidth, originalHeight) > MAX_CANVAS_EDGE) {
        fail('CANVAS_TOO_LARGE',
          'This image is ' + Math.max(originalWidth, originalHeight) +
          ' px across, which is larger than a browser canvas supports. Please resize it first.');
      }
      if (!sourceFormat) {
        fail('UNSUPPORTED_TYPE', 'Unsupported file type. Please choose a JPG, PNG or WebP image.');
      }

      var outputFormat = resolveOutputFormat(options.outputFormat, sourceFormat);

      /* Dimensions change only when the user explicitly picks a limit. */
      var width = originalWidth;
      var height = originalHeight;
      if (options.maxDimension > 0 && Math.max(originalWidth, originalHeight) > options.maxDimension) {
        var scale = options.maxDimension / Math.max(originalWidth, originalHeight);
        width = Math.max(1, Math.round(originalWidth * scale));
        height = Math.max(1, Math.round(originalHeight * scale));
      }

      plan = {
        sourceBytes: blob.size,
        sourceFormat: sourceFormat,
        outputFormat: outputFormat,
        width: width,
        height: height,
        originalWidth: originalWidth,
        originalHeight: originalHeight,
        resized: (width !== originalWidth || height !== originalHeight)
      };
    }).catch(function (err) {
      if (decoded) { release(decoded); decoded = null; }
      throw asCompressError(err, 'DECODE_FAILED',
        'This file could not be read as an image. It may be damaged, or it may not really be a JPG, PNG or WebP file.');
    }).then(function () {
      /* Phase 2 — draw and encode. The pixels are known good by now, so a
         failure here is the browser's encoder giving up, not a bad file. */
      var prepared = (plan.outputFormat === 'jpeg')
        ? prepareJpegCanvas(decoded, plan.width, plan.height)
        : { canvas: drawToCanvas(decoded, plan.width, plan.height, plan.outputFormat === 'png'), hadAlpha: false };
      var canvas = prepared.canvas;
      release(decoded);
      decoded = null;

      return (plan.outputFormat === 'png'
        ? compressPng(canvas, options)
        : compressLossy(canvas, plan.outputFormat, options, prepared.hadAlpha))
        .then(function (meta) { return buildResult(plan, meta, options); });
    }).catch(function (err) {
      throw asCompressError(err, 'ENCODE_FAILED',
        'This image could not be compressed. Please try a different format or a smaller image.');
    });
  }

  function buildResult(shared, meta, options) {
    var size = meta.blob.size;
    var target = options.targetBytes;
    return {
      blob: meta.blob,
      sourceBytes: shared.sourceBytes,
      outputBytes: size,
      sourceFormat: shared.sourceFormat,
      outputFormat: shared.outputFormat,
      width: shared.width,
      height: shared.height,
      originalWidth: shared.originalWidth,
      originalHeight: shared.originalHeight,
      resized: shared.resized,
      quality: meta.quality,
      detail: meta.detail,
      iterations: meta.iterations,
      hasAlpha: meta.hasAlpha,
      flattened: !!meta.flattened,
      targetBytes: target,
      targetReached: target ? size <= target : true,
      significantLoss: !!meta.significantLoss
    };
  }

  /* ======================================================================
     15. JPG / WebP path
     ====================================================================== */

  function compressLossy(canvas, format, options, hadAlpha) {
    var mime = MIME_BY_FORMAT[format];
    var target = options.targetBytes;
    var startQuality = options.quality;

    return canvasToBlob(canvas, mime, startQuality).then(function (blob) {
      var meta = {
        blob: blob, quality: startQuality, iterations: 1,
        detail: 'Quality ' + Math.round(startQuality * 100),
        hasAlpha: hadAlpha, flattened: hadAlpha
      };
      if (!target || blob.size <= target) { return meta; }
      return searchQuality(canvas, mime, startQuality, target, options).then(function (best) {
        if (best) { meta = best; }
        meta.significantLoss = meta.quality <= MIN_TARGET_QUALITY + 0.03;
        return meta;
      });
    });
  }

  /**
   * Binary search for the highest quality that still fits the target. It starts
   * from the user's own quality, so an already-small image is never encoded
   * again, and stops once the bracket is narrower than 2%. Between one and seven
   * encoder calls happen, instead of one call per slider position.
   *
   * When nothing fits, the smallest result seen is returned so the user gets
   * the best available file rather than the untargeted original encode.
   */
  function searchQuality(canvas, mime, startQuality, target, options) {
    var low = MIN_TARGET_QUALITY;
    var high = startQuality;
    var best = null;
    var smallest = null;
    var calls = 0;

    function step() {
      if (calls >= SEARCH_STEPS || high - low < 0.02) { return Promise.resolve(best || smallest); }
      calls++;
      var quality = (low + high) / 2;
      report(options, 'searching', 40 + Math.round(45 * (calls / SEARCH_STEPS)));
      return canvasToBlob(canvas, mime, quality).then(function (blob) {
        if (!smallest || blob.size < smallest.blob.size) {
          smallest = { blob: blob, quality: quality, iterations: calls,
                       detail: 'Quality ' + Math.round(quality * 100) +
                               ' (lowest the search allowed)' };
        }
        if (blob.size <= target) {
          best = {
            blob: blob, quality: quality, iterations: calls,
            detail: 'Quality ' + Math.round(quality * 100) + ' (found by size search)'
          };
          low = quality;
        } else {
          high = quality;
        }
        return step();
      });
    }
    return step();
  }

  /* ======================================================================
     16. PNG path
     ====================================================================== */

  function compressPng(canvas, options) {
    var target = options.targetBytes;
    var ctx = new PngContext(readPixels(canvas), canvas.width, canvas.height);
    ctx.analyse();

    var greyFirst = !ctx.hasAlpha && ctx.grayOnly;

    return (greyFirst ? encodeGreyscale(ctx, options) : Promise.resolve(null))
      .then(function (grey) {
        if (grey) {
          return {
            blob: grey.blob, quality: options.quality, detail: grey.detail,
            iterations: 1
          };
        }
        if (!target) {
          return encodeIndexed(ctx, colorsForQuality(options.quality), options)
            .then(function (result) {
              result.quality = options.quality;
              result.iterations = 1;
              return result;
            });
        }
        return searchPaletteSize(ctx, target, options);
      })
      .then(function (meta) {
        report(options, 'finalizing', 97);
        meta.hasAlpha = ctx.hasAlpha;
        meta.significantLoss = !!meta.significantLoss;
        return meta;
      });
  }

  /**
   * Target-size mode for PNG. The ladder runs from richest to poorest palette,
   * so a plain binary search finds the most colours that still fit. If even the
   * minimum palette overshoots the target the search gives up rather than
   * degrading the image further, and the UI explains why.
   */
  function searchPaletteSize(ctx, target, options) {
    var best = null;
    var calls = 0;

    function attempt(lowIndex, highIndex) {
      if (calls >= SEARCH_STEPS || highIndex < lowIndex) { return Promise.resolve(best); }
      calls++;
      var mid = (lowIndex + highIndex) >> 1;
      report(options, 'searching', 35 + Math.round(50 * (calls / SEARCH_STEPS)));

      return encodeIndexed(ctx, PALETTE_LADDER[mid], options).then(function (result) {
        if (result.blob.size <= target) {
          best = {
            blob: result.blob, quality: qualityForColors(PALETTE_LADDER[mid]),
            detail: result.detail, iterations: calls
          };
          return attempt(0, mid - 1);              // the ladder runs richest
        }                                          // first, so look left
        return attempt(mid + 1, highIndex);       // too large, use fewer colours
      });
    }

    return attempt(0, PALETTE_LADDER.length - 1).then(function (result) {
      if (result) { return result; }
      return encodeIndexed(ctx, MIN_TARGET_COLORS, options).then(function (result) {
        result.quality = qualityForColors(MIN_TARGET_COLORS);
        result.iterations = calls + 1;
        result.significantLoss = true;
        return result;
      });
    });
  }

  /* ======================================================================
     17. In-browser ZIP writer (STORE method)
     ----------------------------------------------------------------------
     Images are already compressed, so storing them uncompressed costs almost
     nothing and keeps this to a few dozen lines with no third-party library.
     The archive is assembled in memory from Blobs the browser already holds.
     ====================================================================== */

  function zipStore(entries) {
    var CHUNK = 0xffff;
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var name = textToBytes(entry.name);
      var bytes = entry.bytes;
      var checksum = crc32(bytes);
      var size = bytes.length;

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);      // UTF-8 filename flag
      lv.setUint16(8, 0, true);           // method 0 = stored
      lv.setUint16(12, 0x0021, true);     // fixed date: 1 Jan 1980
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);

      /* One local header per entry, then the bytes. The data is handed over as
         several Blob parts so a large image is never copied into one big buffer,
         but the parts concatenate back into one contiguous run, which is what a
         ZIP reader expects. Repeating the header per chunk would corrupt every
         entry larger than the chunk size. */
      localParts.push(local);
      for (var at = 0; at < size; at += CHUNK) {
        localParts.push(bytes.subarray(at, Math.min(at + CHUNK, size)));
      }

      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(14, 0x0021, true);
      cv.setUint32(16, checksum, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);

      offset += local.length + size;
    }

    var centralSize = 0;
    for (var c = 0; c < centralParts.length; c++) { centralSize += centralParts[c].length; }

    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(localParts.concat(centralParts, [end]), { type: 'application/zip' });
  }

  function textToBytes(text) {
    if (typeof TextEncoder === 'function') { return new TextEncoder().encode(text); }
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) { out.push(code); }
      else if (code < 0x800) { out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f)); }
      else { out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
    }
    return new Uint8Array(out);
  }

  /* ======================================================================
     18. Public API
     ====================================================================== */

  return {
    INPUT_MIME: INPUT_MIME,
    MIME_BY_FORMAT: MIME_BY_FORMAT,
    EXT_BY_FORMAT: EXT_BY_FORMAT,
    LABEL_BY_FORMAT: LABEL_BY_FORMAT,
    MAX_INPUT_BYTES: MAX_INPUT_BYTES,
    WARN_INPUT_BYTES: WARN_INPUT_BYTES,
    WARN_PIXELS: WARN_PIXELS,
    MAX_PIXELS: MAX_PIXELS,
    MIN_TARGET_QUALITY: MIN_TARGET_QUALITY,
    MIN_TARGET_COLORS: MIN_TARGET_COLORS,

    isSupportedMime: isSupportedMime,
    formatOfMime: formatOfMime,
    formatBytes: formatBytes,
    colorsForQuality: colorsForQuality,
    resolveOutputFormat: resolveOutputFormat,
    makeError: makeError,
    compress: compress,
    zipStore: zipStore
  };
}));
