/* ==========================================================================
   worker.js — runs the compression engine off the main thread.
   --------------------------------------------------------------------------
   Keeping the work in a worker is what stops the interface freezing while a
   large image is being processed: the page stays scrollable and responsive and
   progress messages keep arriving.

   The worker imports the very same engine file the main thread uses, so there
   is exactly one implementation of the compression logic in the project.

   It is a classic (non-module) worker, which is the most widely supported form,
   and it is loaded with a path relative to this file so it works unchanged on
   GitHub Pages, including under a /repository-name/ sub-path.
   ========================================================================== */
'use strict';

importScripts('compressor.js');

/**
 * Request envelope in:  { id, file, options }
 *   file     — a File/Blob; structured-cloned, so bytes are copied, never sent.
 *   options  — { quality, outputFormat, targetBytes, maxDimension }
 *
 * Messages out:
 *   { id, type: 'progress', phase, percent }
 *   { id, type: 'done', result }
 *   { id, type: 'error', code, message }
 */
function send(message) {
  self.postMessage(message);
}

function sendError(id, code, message) {
  send({ id: id, type: 'error', code: code, message: message });
}

self.onmessage = function (event) {
  var data = event.data || {};
  var id = data.id;

  if (typeof data.file === 'undefined' || data.file === null) {
    sendError(id, 'NO_FILE', 'No image was provided.');
    return;
  }

  var options = data.options || {};
  options.onProgress = function (phase, percent) {
    send({ id: id, type: 'progress', phase: phase, percent: percent });
  };

  send({ id: id, type: 'progress', phase: 'starting', percent: 2 });

  /* A rejection inside this promise chain does not surface as a worker error
     event, which would leave the page showing an endless progress bar. Every
     exit therefore reports back explicitly. */
  ImageCompressor.compress(data.file, options).then(function (result) {
    /* The result carries a Blob. Blobs are structured-cloneable but are not
       transferable, so they must never appear in a transfer list — doing so
       throws a DataCloneError and the page would wait forever. Cloning a Blob
       hands over a reference to the browser's blob store, not a byte copy, so
       nothing is duplicated. */
    try {
      send({ id: id, type: 'done', result: result });
    } catch (err) {
      sendError(id, 'RESULT_UNSENDABLE',
        'The compressed image could not be handed back to the page.');
    }
  }, function (error) {
    sendError(id, (error && error.code) || 'UNKNOWN',
      (error && error.message) || 'The image could not be compressed.');
  }).catch(function (error) {
    sendError(id, (error && error.code) || 'UNKNOWN',
      (error && error.message) || 'The image could not be compressed.');
  });
};
