/* ==========================================================================
   app.js — user interface, state and file handling.
   --------------------------------------------------------------------------
   Privacy: this file never sends image data anywhere. The only object URLs it
   creates point at Blobs that already live in the browser's own memory, and
   every one of them is revoked when it is no longer needed. There is no
   fetch(), XMLHttpRequest, WebSocket, FormData or <form> submission here.
   ========================================================================== */
(function () {
  'use strict';

  var C = window.ImageCompressor;
  if (!C) { return; }

  /* ======================================================================
     1. Element references
     ====================================================================== */

  function el(id) { return document.getElementById(id); }

  var dom = {
    dropzone: el('dropzone'),
    fileInput: el('file-input'),
    statusBar: el('status-bar'),
    statusText: el('status-text'),
    rejected: el('rejected'),
    rejectedList: el('rejected-list'),
    workspace: el('workspace'),
    fileList: el('filelist'),
    clearAll: el('clear-all'),
    warnings: el('warnings'),

    quality: el('quality'),
    qualityValue: el('quality-value'),
    qualityNote: el('quality-mode-note'),
    outputFormat: el('output-format'),
    formatHint: el('format-hint'),
    targetSize: el('target-size'),
    customTarget: el('custom-target'),
    customTargetInput: el('custom-target-input'),
    customTargetHint: el('custom-target-hint'),
    maxDimension: el('max-dimension'),

    compressBtn: el('compress-btn'),
    cancelBtn: el('cancel-btn'),

    singleResult: el('single-result'),
    singleFilename: el('single-filename'),
    singleStats: el('single-stats'),
    singleNotice: el('single-notice'),
    beforeImg: el('single-before-img'),
    afterImg: el('single-after-img'),
    beforeMeta: el('single-before-meta'),
    afterMeta: el('single-after-meta'),
    downloadBtn: el('download-btn'),
    anotherBtn: el('another-btn'),

    multiResult: el('multi-result'),
    multiSummary: el('multi-summary'),
    multiNotice: el('multi-notice'),
    multiBody: el('multi-tbody'),
    downloadAllBtn: el('download-all-btn'),
    multiAnotherBtn: el('multi-another-btn'),

    year: el('year')
  };

  /* ======================================================================
     2. State
     ====================================================================== */

  var items = [];             // one entry per selected file
  var nextId = 1;
  var running = false;
  var runToken = 0;          // bumped on cancel, so a stale loop stops itself
  var jobCounter = 0;
  var pendingJobs = {};      // worker job id → { resolve, reject }
  var worker = null;
  var workerUnavailable = false;

  /* ======================================================================
     3. Object URL bookkeeping
     ----------------------------------------------------------------------
     Object URLs pin their Blob in memory until revoked, so every URL this app
     creates is registered and released deliberately.
     ====================================================================== */

  var liveUrls = [];

  function trackUrl(url) { liveUrls.push(url); return url; }

  function releaseUrl(url) {
    if (!url) { return; }
    var at = liveUrls.indexOf(url);
    if (at !== -1) { liveUrls.splice(at, 1); }
    URL.revokeObjectURL(url);
  }

  function releaseAllUrls() {
    for (var i = 0; i < liveUrls.length; i++) { URL.revokeObjectURL(liveUrls[i]); }
    liveUrls = [];
  }

  /** Points an <img> at a fresh object URL, releasing the previous one. */
  function setImageSource(img, blob, altText) {
    if (!img) { return; }
    if (img.dataset.objectUrl) { releaseUrl(img.dataset.objectUrl); }
    var url = trackUrl(URL.createObjectURL(blob));
    img.dataset.objectUrl = url;
    img.src = url;
    img.alt = altText || '';
  }

  /* ======================================================================
     4. Small DOM helpers
     ====================================================================== */

  function clear(node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } }

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function percentSaved(originalBytes, compressedBytes) {
    if (!originalBytes) { return 0; }
    return (1 - compressedBytes / originalBytes) * 100;
  }

  function megapixels(width, height) { return (width * height) / 1e6; }

  /* ======================================================================
     5. Status line
     ====================================================================== */

  var progressBar = null;

  function ensureProgressBar() {
    if (progressBar) { return progressBar; }
    progressBar = create('div', 'progress');
    progressBar.setAttribute('aria-hidden', 'true');
    progressBar.appendChild(create('div', 'progress-bar'));
    dom.statusBar.appendChild(progressBar);
    return progressBar;
  }

  function setStatus(tone, text, busy) {
    dom.statusBar.hidden = false;
    dom.statusBar.dataset.tone = tone;
    if (busy) { dom.statusBar.dataset.busy = 'true'; }
    else { dom.statusBar.removeAttribute('data-busy'); }
    dom.statusText.textContent = text;
    if (!busy && progressBar) { progressBar.hidden = true; }
  }

  function setProgress(percent) {
    ensureProgressBar().hidden = false;
    progressBar.firstChild.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }

  /* The four states a user can be in are always announced in this bar:
     waiting, processing, complete and failed. Hiding it while the queue is
     empty would leave the first state invisible, so it is shown from the
     start instead. */
  function showWaiting() {
    setStatus('idle', 'Waiting for image — drop a file here or choose one to begin.', false);
  }

  var PHASE_TEXT = {
    starting: 'Starting',
    decoding: 'Reading the image',
    encoding: 'Compressing',
    mapping: 'Rebuilding the colour palette',
    searching: 'Searching for a smaller file',
    finalizing: 'Finishing up'
  };
  /* ======================================================================
     6. Validation
     ====================================================================== */

  var ACCEPTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

  /**
   * Returns null when the file can be processed, or a human-readable reason.
   * Some systems hand over an empty MIME type, so the extension is checked too.
   */
  function rejectionReason(file) {
    if (!file) { return 'this item is not a file.'; }
    if (file.size === 0) { return 'the file is empty (0 bytes).'; }
    if (C.isSupportedMime(file.type)) { return null; }
    var parts = (file.name || '').toLowerCase().split('.');
    var extension = parts.length > 1 ? parts.pop() : '';
    if (ACCEPTED_EXTENSIONS.indexOf(extension) !== -1) { return null; }
    /* A JPG/PNG/WebP extension with no usable type comes from a system that does
       not report MIME types. It is let through and sniffed instead of turned
       away, so a real image is never rejected because of where it came from. */
    if (file.type) { return 'unsupported file type (' + file.type + ').'; }
    return 'the file type could not be recognised.';
  }

  function detectFormat(file) {
    var byMime = C.formatOfMime(file.type);
    if (byMime) { return byMime; }
    var parts = (file.name || '').toLowerCase().split('.');
    var extension = parts.length > 1 ? parts.pop() : '';
    if (extension === 'jpg' || extension === 'jpeg') { return 'jpeg'; }
    if (extension === 'png') { return 'png'; }
    if (extension === 'webp') { return 'webp'; }
    return null;
  }

  /* ======================================================================
     7. Adding files
     ====================================================================== */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) { return; }

    var rejected = [];
    files.forEach(function (file) {
      var reason = rejectionReason(file);
      if (reason) {
        rejected.push({ name: file.name, reason: reason });
        return;
      }
      var item = createItem(file);
      items.push(item);
      loadPreview(item);
    });

    renderRejections(rejected);
    dom.workspace.hidden = false;
    renderFileList();
    renderWarnings();
    renderResults();
    refresh();
    updateSummaryStatus();

    if (rejected.length) {
      var allUnsupported = rejected.every(function (entry) {
        return entry.reason.indexOf('unsupported file type') === 0;
      });
      setStatus('warning', allUnsupported
        ? 'Unsupported file type. Please choose a JPG, PNG or WebP image.'
        : 'Some files could not be added — see the list above.', false);
    }
  }

  function createItem(file) {
    return {
      id: nextId++,
      file: file,
      name: file.name,
      size: file.size,
      format: detectFormat(file),
      width: 0,
      height: 0,
      previewUrl: null,
      status: 'queued',
      result: null,
      error: null
    };
  }

  function renderRejections(list) {
    clear(dom.rejectedList);
    if (!list.length) { dom.rejected.hidden = true; return; }
    for (var i = 0; i < list.length; i++) {
      dom.rejectedList.appendChild(create('li', null, list[i].name + ' — ' + list[i].reason));
    }
    dom.rejected.hidden = false;
  }

  /**
   * Reads the natural size of each file from a detached <img> so warnings can
   * be shown before any compression starts. The browser decodes the file only
   * as far as layout needs, and nothing leaves the device.
   */
  function loadPreview(item) {
    var url = trackUrl(URL.createObjectURL(item.file));
    item.previewUrl = url;
    var probe = new Image();
    probe.onload = function () {
      item.width = probe.naturalWidth;
      item.height = probe.naturalHeight;
      renderFileList();
      renderWarnings();
      refresh();
    };
    probe.onerror = function () {
      item.status = 'error';
      item.error = 'This file could not be read as an image. It may be damaged or incomplete.';
      renderFileList();
      refresh();
      updateSummaryStatus();
    };
    probe.src = url;
  }

  /* ======================================================================
     8. File list
     ====================================================================== */

  var STATE_TEXT = {
    queued: 'Waiting to compress',
    working: 'Compressing…',
    done: 'Compressed',
    stale: 'Settings changed — compress again',
    error: 'Failed'
  };

  function renderFileList() {
    clear(dom.fileList);
    items.forEach(function (item) {
      var li = create('li', 'filelist-item');
      li.dataset.state = item.status;

      var thumb = create('img', 'filelist-thumb');
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      thumb.alt = '';
      if (item.previewUrl) { thumb.src = item.previewUrl; }

      var body = create('div', 'filelist-body');
      body.appendChild(create('div', 'filelist-name', item.name));
      var meta = create('div', 'filelist-meta');
      var details = [C.formatBytes(item.size)];
      if (item.width) {
        details.push(item.width + ' × ' + item.height);
        details.push(C.LABEL_BY_FORMAT[item.format] || 'Image');
      }
      meta.appendChild(document.createTextNode(details.join(' • ')));
      meta.appendChild(create('br'));
      var state = create('span', 'filelist-state', STATE_TEXT[item.status] || '');
      meta.appendChild(state);
      body.appendChild(meta);

      /* The reason a file failed is written out, not left in a tooltip: tooltips
         do not appear on touch screens and are easy to miss with a keyboard or a
         screen reader. */
      if (item.status === 'error' && item.error) {
        var why = create('p', 'filelist-error', item.error);
        body.appendChild(why);
      }

      var remove = create('button', 'icon-btn icon-btn--danger', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + item.name);
      remove.addEventListener('click', function () { removeItem(item.id); });

      li.appendChild(thumb);
      li.appendChild(body);
      li.appendChild(remove);
      dom.fileList.appendChild(li);
    });
  }

  /* ======================================================================
     9. Warnings for large or unusual files
     ====================================================================== */

  function renderWarnings() {
    clear(dom.warnings);
    var notes = [];

    items.forEach(function (item) {
      if (item.size > C.WARN_INPUT_BYTES) {
        notes.push(item.name + ' is ' + C.formatBytes(item.size) +
          '. Large images take longer to process and use more memory on your device.');
      }
      if (item.width && megapixels(item.width, item.height) * 1e6 > C.WARN_PIXELS) {
        notes.push(item.name + ' is ' + item.width + ' × ' + item.height + ' (' +
          megapixels(item.width, item.height).toFixed(1) +
          ' megapixels). If your device struggles, set a resize limit below — ' +
          'dimensions are never changed on their own.');
      }
    });

    if (notes.length) {
      var box = create('div', 'notice notice-warning');
      var list = create('ul');
      list.style.margin = '0';
      list.style.paddingLeft = '1.1rem';
      notes.forEach(function (text) { list.appendChild(create('li', null, text)); });
      box.appendChild(list);
      dom.warnings.appendChild(box);
    }
    dom.warnings.hidden = notes.length === 0;
  }

  /* ======================================================================
     10. Settings
     ====================================================================== */

  function readSettings() {
    var targetChoice = dom.targetSize.value;
    var targetBytes = null;
    if (targetChoice === 'custom') {
      targetBytes = Math.max(1, Math.floor(Number(dom.customTargetInput.value) || 0)) || null;
    } else if (targetChoice !== 'quality') {
      targetBytes = Math.floor(Number(targetChoice));
    }
    return {
      quality: Number(dom.quality.value) / 100,
      outputFormat: dom.outputFormat.value,
      targetBytes: targetBytes,
      maxDimension: Number(dom.maxDimension.value) || 0
    };
  }

  /** The PNG note appears whenever PNG is what will actually be written. */
  function effectiveOutputFormat(settings) {
    if (settings.outputFormat !== 'keep') { return settings.outputFormat; }
    if (!items.length) { return null; }
    var first = items[0].format;
    var allSame = items.every(function (item) { return item.format === first; });
    return allSame ? first : null;
  }

  function refreshSettingHints() {
    var quality = Number(dom.quality.value);
    dom.qualityValue.textContent = String(quality);
    dom.quality.style.setProperty('--fill', ((quality - 10) / 90 * 100) + '%');

    var settings = readSettings();
    var format = effectiveOutputFormat(settings);
    dom.qualityNote.textContent = (format === 'png')
      ? ' For PNG this controls how many colours are kept, not a JPG-style quality value.'
      : '';
    dom.quality.setAttribute('aria-valuetext', quality + (format === 'png' ? ' — colour depth' : ''));

    dom.customTarget.hidden = dom.targetSize.value !== 'custom';
    if (dom.targetSize.value === 'custom') {
      var bytes = Math.max(0, Math.floor(Number(dom.customTargetInput.value) || 0));
      dom.customTargetHint.textContent = 'Value is in bytes. ' +
        bytes + ' bytes is about ' + C.formatBytes(bytes) + '.';
    }

    dom.formatHint.textContent = (format === 'png')
      ? 'PNG output keeps transparency. Quality is applied as colour reduction, not lossy compression.'
      : (settings.outputFormat === 'jpeg'
        ? 'JPG does not support transparency. Transparent areas are composited onto white.'
        : 'Converting between formats can change appearance or transparency.');
  }

  /* ======================================================================
     11. Worker plumbing (with a main-thread fallback)
     ====================================================================== */

  function getWorker() {
    if (workerUnavailable) { return null; }
    if (worker) { return worker; }
    if (typeof Worker === 'undefined') { workerUnavailable = true; return null; }
    try {
      worker = new Worker('js/worker.js');
    } catch (err) {
      workerUnavailable = true;
      return null;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerFailure;
    return worker;
  }

  function onWorkerMessage(event) {
    var data = event.data || {};
    var job = pendingJobs[data.id];
    if (!job) { return; }
    if (data.type === 'progress') {
      job.onProgress(data.phase, data.percent);
      return;
    }
    delete pendingJobs[data.id];
    if (data.type === 'done') { job.resolve(data.result); }
    else { job.reject(C.makeError(data.code || 'UNKNOWN', data.message || 'Compression failed.')); }
  }

  /** A crashed worker is not the user's problem: drop it and retry on the page. */
  function onWorkerFailure() {
    workerUnavailable = true;
    if (worker) { worker.terminate(); worker = null; }
    Object.keys(pendingJobs).forEach(function (id) {
      var job = pendingJobs[id];
      delete pendingJobs[id];
      job.reject({ workerFailed: true });
    });
  }

  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; }
    Object.keys(pendingJobs).forEach(function (id) {
      var job = pendingJobs[id];
      delete pendingJobs[id];
      job.reject({ cancelled: true });
    });
  }

  function compressInWorker(item, settings, onProgress) {
    var active = getWorker();
    if (!active) { return Promise.resolve(null); }
    var id = ++jobCounter;
    return new Promise(function (resolve, reject) {
      pendingJobs[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
      active.postMessage({
        id: id,
        file: item.file,
        options: {
          quality: settings.quality,
          outputFormat: settings.outputFormat,
          targetBytes: settings.targetBytes,
          maxDimension: settings.maxDimension
        }
      });
    });
  }

  function compressOnMainThread(item, settings, onProgress) {
    var options = {
      quality: settings.quality,
      outputFormat: settings.outputFormat,
      targetBytes: settings.targetBytes,
      maxDimension: settings.maxDimension,
      onProgress: onProgress
    };
    return C.compress(item.file, options);
  }

  function compressItem(item, settings, onProgress) {
    return compressInWorker(item, settings, onProgress).then(function (result) {
      return result || compressOnMainThread(item, settings, onProgress);
    }, function (error) {
      if (error && error.workerFailed) {
        return compressOnMainThread(item, settings, onProgress);
      }
      throw error;
    });
  }

  /* ======================================================================
     12. The compression queue
     ====================================================================== */

  function pendingItems() {
    return items.filter(function (item) { return item.status !== 'working'; });
  }

  function compressAll() {
    if (running) { return; }
    var queue = pendingItems();
    if (!queue.length) { return; }

    var settings = readSettings();
    var token = ++runToken;
    running = true;
    setControlsBusy(true);
    queue.forEach(function (item) { item.status = 'queued'; item.error = null; });
    renderFileList();
    updateSummaryStatus();

    var index = 0;

    function next() {
      if (token !== runToken) { return; }          // cancelled
      if (index >= queue.length) { return finish(); }

      var item = queue[index];
      var position = index + 1;
      item.status = 'working';
      renderFileList();
      setStatus('working', 'Processing image ' + position + ' of ' + queue.length +
        ': ' + item.name, true);
      setProgress(0);

      compressItem(item, settings, function (phase, percent) {
        setStatus('working', 'Processing image ' + position + ' of ' + queue.length +
          ': ' + (PHASE_TEXT[phase] || 'Compressing') + '…', true);
        setProgress(percent);
      }).then(function (result) {
        if (token !== runToken) { return; }
        item.result = result;
        item.status = 'done';
        item.width = result.width;
        item.height = result.height;
        index++;
        renderFileList();
        renderResults();
        next();
      }, function (error) {
        if (token !== runToken || (error && error.cancelled)) { return; }
        item.result = null;
        item.status = 'error';
        item.error = (error && error.message) || 'This image could not be compressed.';
        index++;
        renderFileList();
        next();
      });
    }

    function finish() {
      running = false;
      setControlsBusy(false);
      renderResults();
      updateSummaryStatus();
      revealResults();
    }

    next();
  }

  function cancelRun() {
    runToken++;
    running = false;
    stopWorker();
    setControlsBusy(false);
    items.forEach(function (item) {
      if (item.status === 'working' || item.status === 'queued') { item.status = 'queued'; }
    });
    renderFileList();
    updateSummaryStatus();
  }

  /* ======================================================================
     13. Controls
     ====================================================================== */

  /** The button's resting caption. The status messages quote it, so the
      wording only has to exist in one place. */
  function compressLabel() {
    return items.length > 1 ? 'Compress All Images (' + items.length + ')' : 'Compress Image';
  }

  function setControlsBusy(busy) {
    dom.compressBtn.disabled = busy;
    dom.cancelBtn.hidden = !busy;
    dom.compressBtn.textContent = busy ? 'Compressing…' : compressLabel();
  }

  function refresh() {
    setControlsBusy(running);
    dom.compressBtn.disabled = running || items.length === 0;
    dom.clearAll.disabled = running || items.length === 0;
  }

  /* Called whenever a run is not in progress, so the bar always describes the
     real state. It has to run after a cancel too, otherwise the last
     "Processing…" message and its spinner would stay on screen for good. */
  function updateSummaryStatus() {
    if (running) { return; }
    if (!items.length) { showWaiting(); return; }

    var total = items.length;
    var errors = items.filter(function (item) { return item.status === 'error'; });
    var done = items.filter(function (item) { return item.status === 'done'; }).length;
    var failed = errors.length;
    var noun = total === 1 ? 'image' : 'images';
    var again = ' Press “' + compressLabel() + '” to start again.';

    if (done === 0 && failed === 0) {
      setStatus('info', 'Waiting for image — ' + total +
        (total === 1 ? ' image is' : ' images are') + ' ready. Press “' +
        compressLabel() + '” to start.', false);
    } else if (done === 0) {
      setStatus('error', (total === 1
        ? 'Compression failed. '
        : 'Compression failed — none of the ' + total + ' images could be compressed. ') +
        ((errors[0] && errors[0].error) || ''), false);
    } else if (done + failed < total) {
      setStatus('info', 'Stopped — ' + done + ' of ' + total + ' ' + noun +
        ' compressed so far.' + again, false);
    } else if (failed) {
      setStatus('warning', 'Compression complete with errors — ' + done + ' of ' + total +
        ' ' + noun + ' compressed, ' + failed + ' failed.', false);
    } else {
      setStatus('done', 'Compression complete — ' + done + ' of ' + total + ' ' +
        noun + ' compressed.', false);
    }
  }

  /** Results already on screen are stale once the settings change. */
  function markResultsStale() {
    if (running) { return; }
    var changed = false;
    items.forEach(function (item) {
      if (item.status === 'done') { item.status = 'stale'; changed = true; }
    });
    if (changed) { renderFileList(); }
  }

  /* ======================================================================
     14. Result rendering
     ====================================================================== */

  function renderResults() {
    var done = items.filter(function (item) { return item.status === 'done'; });
    if (!done.length) {
      dom.singleResult.hidden = true;
      dom.multiResult.hidden = true;
      return;
    }
    if (items.length === 1) {
      renderSingle(done[0]);
      dom.multiResult.hidden = true;
    } else {
      dom.singleResult.hidden = true;
      renderMulti(done);
    }
  }

  /** Brings the finished result into view so the download button never depends
      on the user happening to scroll far enough to find it. Does nothing when
      nothing finished, and jumps instead of animating when reduced motion is
      requested. */
  function revealResults() {
    var panel = items.length === 1 ? dom.singleResult : dom.multiResult;
    if (panel.hidden) { return; }
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }

  function statTile(label, value, modifier) {
    var tile = create('div', 'stat' + (modifier ? ' ' + modifier : ''));
    tile.appendChild(create('span', 'stat-label', label));
    tile.appendChild(create('span', 'stat-value', value));
    return tile;
  }

  function metaList(node, rows) {
    clear(node);
    rows.forEach(function (row) {
      node.appendChild(create('dt', null, row[0]));
      node.appendChild(create('dd', null, row[1]));
    });
  }

  function renderSingle(item) {
    var result = item.result;
    var saved = percentSaved(result.sourceBytes, result.outputBytes);
    var grew = saved < 0;

    dom.singleResult.hidden = false;
    dom.singleFilename.textContent = item.name;
    dom.singleFilename.title = item.name;

    clear(dom.singleStats);
    dom.singleStats.appendChild(statTile('Original', C.formatBytes(result.sourceBytes)));
    dom.singleStats.appendChild(statTile('Compressed', C.formatBytes(result.outputBytes)));
    dom.singleStats.appendChild(statTile(
      grew ? 'Larger by' : 'Saved',
      Math.abs(saved).toFixed(1) + '%',
      grew ? 'stat--grown' : 'stat--saved'));
    dom.singleStats.appendChild(statTile('Output', C.LABEL_BY_FORMAT[result.outputFormat]));
    dom.singleStats.appendChild(statTile(
      result.outputFormat === 'png' ? 'Colour handling' : 'Quality',
      result.outputFormat === 'png' ? result.detail : Math.round(result.quality * 100) + ' / 100'));
    dom.singleStats.appendChild(statTile(
      'Dimensions', result.width + ' × ' + result.height));

    var messages = resultMessages(item, result, grew);
    if (messages.length) {
      dom.singleNotice.className = 'notice ' + messages[0][0];
      clear(dom.singleNotice);
      var list = create('ul');
      list.style.margin = '0';
      list.style.paddingLeft = '1.1rem';
      messages.forEach(function (entry) { list.appendChild(create('li', null, entry[1])); });
      dom.singleNotice.appendChild(list);
      dom.singleNotice.hidden = false;
    } else {
      dom.singleNotice.hidden = true;
    }

    setImageSource(dom.beforeImg, item.file,
      'Original ' + item.name + ', ' + result.originalWidth + ' by ' + result.originalHeight +
      ' pixels, ' + C.formatBytes(result.sourceBytes));
    setImageSource(dom.afterImg, result.blob,
      'Compressed ' + item.name + ', ' + result.width + ' by ' + result.height +
      ' pixels, ' + C.formatBytes(result.outputBytes));

    metaList(dom.beforeMeta, [
      ['Format', C.LABEL_BY_FORMAT[result.sourceFormat]],
      ['Dimensions', result.originalWidth + ' × ' + result.originalHeight],
      ['File size', C.formatBytes(result.sourceBytes)]
    ]);
    metaList(dom.afterMeta, [
      ['Format', C.LABEL_BY_FORMAT[result.outputFormat]],
      ['Dimensions', result.width + ' × ' + result.height],
      ['File size', C.formatBytes(result.outputBytes)]
    ]);

    dom.downloadBtn.textContent = 'Download Compressed Image';
  }

  function resultMessages(item, result, grew) {
    var messages = [];
    if (result.targetBytes) {
      if (result.targetReached) {
        messages.push(['notice-success', 'Target of ' + C.formatBytes(result.targetBytes) +
          ' reached: the result is ' + C.formatBytes(result.outputBytes) +
          '. An exact match is never guaranteed, so this is as close as the search could get' +
          ' without hurting quality.']);
      } else {
        messages.push(['notice-warning', 'The requested size could not be reached without ' +
          'significant quality loss. Try a larger target size or reduce the image dimensions. ' +
          'The closest acceptable result is ' + C.formatBytes(result.outputBytes) + '.']);
      }
    }
    if (grew) {
      messages.push(['notice-warning', 'The compressed file came out ' +
        Math.abs(percentSaved(result.sourceBytes, result.outputBytes)).toFixed(1) +
        '% larger than the original. This format was already well optimised, so the ' +
        'original is the better file to keep.']);
    }
    if (result.flattened) {
      messages.push(['notice-warning', 'JPG does not support transparency, so the transparent ' +
        'areas of ' + item.name + ' were filled in with white.']);
    }
    if (result.resized) {
      messages.push(['notice-info', 'Resized from ' + result.originalWidth + ' × ' +
        result.originalHeight + ' to ' + result.width + ' × ' + result.height +
        ', using the resize limit you selected.']);
    }
    return messages;
  }

  function renderMulti(done) {
    dom.multiResult.hidden = false;
    dom.multiSummary.textContent = done.length + ' of ' + items.length + ' compressed';

    var notices = [];
    done.forEach(function (item) {
      var result = item.result;
      var saved = percentSaved(result.sourceBytes, result.outputBytes);
      if (result.targetBytes && !result.targetReached) {
        notices.push(item.name + ': the requested size could not be reached without ' +
          'significant quality loss. Try a larger target size or reduce the image dimensions.');
      }
      if (result.flattened) {
        notices.push(item.name + ': JPG does not support transparency, so transparent areas ' +
          'were filled in with white.');
      }
      if (saved < 0) {
        notices.push(item.name + ': the compressed file is larger than the original, so this ' +
          'one was already well optimised.');
      }
    });

    if (notices.length) {
      dom.multiNotice.className = 'notice notice-warning';
      clear(dom.multiNotice);
      var list = create('ul');
      list.style.margin = '0';
      list.style.paddingLeft = '1.1rem';
      notices.forEach(function (text) { list.appendChild(create('li', null, text)); });
      dom.multiNotice.appendChild(list);
      dom.multiNotice.hidden = false;
    } else {
      dom.multiNotice.hidden = true;
    }

    clear(dom.multiBody);
    done.forEach(function (item) {
      dom.multiBody.appendChild(buildRow(item));
    });

    dom.downloadAllBtn.disabled = done.length === 0;
  }

  function buildRow(item) {
    var result = item.result;
    var saved = percentSaved(result.sourceBytes, result.outputBytes);
    var tr = create('tr');

    var nameCell = create('td');
    nameCell.appendChild(create('span', 'row-name', item.name));
    nameCell.appendChild(create('span', 'row-sub',
      C.LABEL_BY_FORMAT[result.sourceFormat] + ' → ' + C.LABEL_BY_FORMAT[result.outputFormat] +
      ' · ' + result.originalWidth + ' × ' + result.originalHeight + ' → ' +
      result.width + ' × ' + result.height +
      (result.outputFormat === 'png' ? ' · ' + result.detail : '')));
    tr.appendChild(nameCell);

    tr.appendChild(create('td', 'num', C.formatBytes(result.sourceBytes)));
    tr.appendChild(create('td', 'num', C.formatBytes(result.outputBytes)));

    var savedCell = create('td', 'num');
    savedCell.appendChild(create('span',
      saved >= 0 ? 'saved-positive' : 'saved-negative',
      (saved >= 0 ? '' : 'larger by ') + Math.abs(saved).toFixed(1) + '%'));
    tr.appendChild(savedCell);

    var actionCell = create('td', 'action-col');
    var actions = create('div', 'cell-actions');
    var download = create('button', 'icon-btn', 'Download');
    download.type = 'button';
    download.setAttribute('aria-label', 'Download compressed ' + item.name);
    download.addEventListener('click', function () {
      downloadBlob(result.blob, outputName(item, result));
    });
    var again = create('button', 'icon-btn', 'Recompress');
    again.type = 'button';
    again.setAttribute('aria-label', 'Compress ' + item.name + ' again');
    again.disabled = running;
    again.addEventListener('click', function () { compressAll(); });
    actions.appendChild(download);
    actions.appendChild(again);
    actionCell.appendChild(actions);
    tr.appendChild(actionCell);

    return tr;
  }

  /* ======================================================================
     15. Downloads
     ====================================================================== */

  function baseName(name) {
    var at = name.lastIndexOf('.');
    return at > 0 ? name.slice(0, at) : name;
  }

  function outputName(item, result) {
    var suffix = result.targetBytes ? '-min' : '-compressed';
    return baseName(item.name) + suffix + '.' + C.EXT_BY_FORMAT[result.outputFormat];
  }

  function downloadBlob(blob, filename) {
    var url = trackUrl(URL.createObjectURL(blob));
    var link = create('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    /* The link and its URL both have to outlive the click. Tearing them down in
       the same tick cancels the download in some browsers, and a large file can
       still be being written to disk well after the click has returned, so both
       are released on a timer instead. */
    setTimeout(function () {
      if (link.parentNode) { link.parentNode.removeChild(link); }
      releaseUrl(url);
    }, 30000);
  }

  function downloadAll() {
    var done = items.filter(function (item) { return item.status === 'done'; });
    if (!done.length) { return; }

    var total = done.reduce(function (sum, item) { return sum + item.result.outputBytes; }, 0);
    if (total > 600 * 1024 * 1024) {
      setStatus('error', 'These images total ' + C.formatBytes(total) +
        '. Building a ZIP that large in the browser can exhaust memory — ' +
        'please download them one at a time.', false);
      return;
    }

    setStatus('working', 'Building a ZIP of ' + done.length + ' images…', true);
    setProgress(20);

    var used = {};
    var reads = done.map(function (item, index) {
      var name = outputName(item, item.result).replace(/[\\/:*?"<>|]/g, '_');
      if (used[name]) { used[name] += 1; name = name.replace(/(\.[^.]+)$/, '-' + used[name] + '$1'); }
      else { used[name] = 1; }
      return item.result.blob.arrayBuffer().then(function (buffer) {
        setProgress(20 + Math.round(60 * (index + 1) / done.length));
        return { name: name, bytes: new Uint8Array(buffer) };
      });
    });

    Promise.all(reads).then(function (entries) {
      setProgress(90);
      var zip = C.zipStore(entries);
      downloadBlob(zip, 'compressed-images.zip');
      setStatus('done', 'ZIP ready — ' + done.length + ' images, ' +
        C.formatBytes(zip.size) + '.', false);
    }, function () {
      setStatus('error', 'The ZIP archive could not be created in this browser. ' +
        'Please download the images one at a time.', false);
    });
  }

  /* ======================================================================
     16. Removing files
     ====================================================================== */

  function removeItem(id) {
    if (running) { return; }
    var at = -1;
    for (var i = 0; i < items.length; i++) { if (items[i].id === id) { at = i; break; } }
    if (at === -1) { return; }
    if (items[at].previewUrl) { releaseUrl(items[at].previewUrl); }
    items.splice(at, 1);
    if (!items.length) { resetWorkspace(); return; }
    renderFileList();
    renderWarnings();
    renderResults();
    refresh();
    updateSummaryStatus();
  }

  function clearAll() {
    if (running) { return; }
    items.forEach(function (item) { if (item.previewUrl) { releaseUrl(item.previewUrl); } });
    items = [];
    resetWorkspace();
  }

  function resetWorkspace() {
    dom.workspace.hidden = true;
    dom.singleResult.hidden = true;
    dom.multiResult.hidden = true;
    dom.rejected.hidden = true;
    clear(dom.rejectedList);
    clear(dom.fileList);
    clear(dom.warnings);
    dom.warnings.hidden = true;
    dom.fileInput.value = '';
    refresh();
    showWaiting();
  }

  /* ======================================================================
     17. Wiring
     ====================================================================== */

  function onFilesChosen(fileList) {
    addFiles(fileList);
    dom.fileInput.value = '';
  }

  function wireDropzone() {
    dom.dropzone.addEventListener('click', function (event) {
      // The visible "Choose Image" label is the real control; clicking anywhere
      // else in the zone simply opens the same file picker.
      if (event.target.closest('label')) { return; }
      dom.fileInput.click();
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      dom.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        event.stopPropagation();
        dom.dropzone.classList.add('is-dragover');
        dom.dropzone.dataset.state = 'dragover';
      });
    });

    ['dragleave', 'dragend'].forEach(function (type) {
      dom.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        if (type === 'dragleave' && dom.dropzone.contains(event.relatedTarget)) { return; }
        dom.dropzone.classList.remove('is-dragover');
        dom.dropzone.dataset.state = 'idle';
      });
    });

    dom.dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      dom.dropzone.classList.remove('is-dragover');
      dom.dropzone.dataset.state = 'idle';
      if (event.dataTransfer && event.dataTransfer.files) {
        onFilesChosen(event.dataTransfer.files);
      }
    });

    // Dropping anywhere else must not make the browser navigate to the file.
    ['dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (event) { event.preventDefault(); });
    });

    dom.fileInput.addEventListener('change', function () { onFilesChosen(dom.fileInput.files); });

    document.addEventListener('paste', function (event) {
      if (event.clipboardData && event.clipboardData.files && event.clipboardData.files.length) {
        event.preventDefault();
        onFilesChosen(event.clipboardData.files);
      }
    });
  }

  function wireControls() {
    dom.quality.addEventListener('input', function () {
      refreshSettingHints();
      markResultsStale();
    });
    dom.outputFormat.addEventListener('change', function () {
      refreshSettingHints();
      markResultsStale();
    });
    dom.targetSize.addEventListener('change', function () {
      refreshSettingHints();
      markResultsStale();
    });
    dom.customTargetInput.addEventListener('input', function () {
      refreshSettingHints();
      markResultsStale();
    });
    dom.maxDimension.addEventListener('change', function () {
      refreshSettingHints();
      markResultsStale();
    });

    dom.compressBtn.addEventListener('click', function () { compressAll(); });
    dom.cancelBtn.addEventListener('click', function () { cancelRun(); });
    dom.clearAll.addEventListener('click', function () { clearAll(); });

    dom.downloadBtn.addEventListener('click', function () {
      var item = items.filter(function (entry) { return entry.status === 'done'; })[0];
      if (item) { downloadBlob(item.result.blob, outputName(item, item.result)); }
    });
    dom.downloadAllBtn.addEventListener('click', function () { downloadAll(); });
    dom.anotherBtn.addEventListener('click', function () { clearAll(); });
    dom.multiAnotherBtn.addEventListener('click', function () { clearAll(); });

    window.addEventListener('pagehide', function () {
      stopWorker();
      releaseAllUrls();
    });
  }

  function init() {
    items = [];
    wireDropzone();
    wireControls();
    refreshSettingHints();
    refresh();
    showWaiting();
    if (dom.year) { dom.year.textContent = String(new Date().getFullYear()); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
