# Free Image Compressor

A static website that compresses JPG, PNG and WebP images **entirely inside the
visitor's browser**. There is no backend, no build step and no dependency to
install. Compression happens on the user's own device, so images are never
uploaded anywhere.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Privacy design](#privacy-design)
3. [Project structure](#project-structure)
4. [How it works](#how-it-works)
5. [Before you publish — replace the placeholders](#before-you-publish--replace-the-placeholders)
6. [Deploy to GitHub Pages](#deploy-to-github-pages)
7. [Add a custom domain later](#add-a-custom-domain-later)
8. [Editing the advertisement placeholders](#editing-the-advertisement-placeholders)
9. [Testing checklist](#testing-checklist)
10. [Browser support](#browser-support)
11. [Privacy verification](#privacy-verification)
12. [Troubleshooting](#troubleshooting)

---

## What it does

- Accepts JPG/JPEG, PNG and WebP by drag-and-drop, file picker or clipboard paste.
- Output format: **keep original**, **JPG**, **PNG** or **WebP**.
- Quality slider from 10 to 100, default 80.
- **Target file size mode**: original quality, 50 KB, 100 KB, 200 KB, 500 KB,
  1 MB, or a custom number of bytes. The tool searches for the highest quality
  that fits under the target. It never claims to hit an exact size, and when the
  target cannot be reached without wrecking the image it says so and suggests a
  larger target or smaller dimensions.
- Optional resize limit. **Nothing is ever resized unless you choose a limit.**
- Side-by-side before/after previews on desktop, stacked on mobile.
- Multiple images at once, each downloadable on its own, plus **Download All**
  which builds a ZIP in the browser.
- Large images get a warning; images over 80 megapixels are refused with an
  explanation rather than crashing the tab.

### Layout

The whole point is that nothing important is hidden below the fold. From 860 px
up the tool is two columns — the selected files on the left, the settings and the
**Compress** button on the right — and the drop zone is a single horizontal band
rather than a tall block. The options are therefore on screen at the same moment
as the upload area, instead of one screen further down. Below 860 px the two
columns simply stack in the same order.

When a run finishes, the result is scrolled into view, so the **Download** button
never depends on the user guessing that they should keep scrolling. That scroll is
skipped for anyone who has asked for reduced motion.

### A note on PNG quality

A PNG quality slider does not behave like a JPG one, because PNG is lossless.
This tool's slider controls how far the **colour palette** is reduced, and it
switches to a smaller greyscale depth where the image allows it. That suits
screenshots, logos and flat graphics. For a detailed photograph, converting to
JPG or WebP is nearly always the better move, and the tool tells you so. The
before/after previews are there so you can judge for yourself.

---

## Privacy design

This is the central design constraint, not a feature bolted on afterwards.

- No `fetch()`, no `XMLHttpRequest`, no `WebSocket`, no `sendBeacon`, no
  `FormData`, no `<form>` upload, no dynamic `import()`.
- No `localStorage`, `sessionStorage`, `IndexedDB`, `Cache Storage` or
  `document.cookie`.
- No analytics, no tag manager, no font CDN, no third-party library.
- No service worker, so nothing is cached between visits.
- Preview object URLs use `URL.createObjectURL`, and each one is revoked as soon
  as it is no longer on screen. The URL behind a download click is released on a
  30-second timer instead, because a link or a URL that disappears in the same
  tick as the click cancels the download in some browsers, and a large ZIP can
  still be being written to disk well after the click returns.

The only network requests the page makes are the plain `GET`s for its own HTML,
CSS, JavaScript and images. The ZIP is assembled from `Blob` parts in memory.

You can confirm this yourself with the method in
[Privacy verification](#privacy-verification).

---

## Project structure

```
.
├── index.html          the tool, content sections and FAQ
├── privacy.html        privacy policy
├── terms.html          terms of use
├── about.html          about page
├── contact.html        contact page
├── 404.html            not-found page
├── robots.txt          crawler rules
├── sitemap.xml         sitemap
├── site.webmanifest    PWA metadata (installability, no service worker)
├── README.md           this file
├── assets/
│   ├── favicon.svg     vector icon
│   ├── favicon.png     512×512 raster icon
│   └── og-image.png    1200×630 social share image
├── css/
│   └── styles.css      the only stylesheet
└── js/
    ├── app.js          UI, state, queue and worker plumbing
    ├── compressor.js   the compression engine
    └── worker.js       Web Worker entry point
```

All paths are relative, so the site works unchanged at
`/username.github.io/repo-name/`, at a custom domain, or from a local folder.

---

## How it works

### `js/compressor.js` — the engine

Written as a classic script wrapped in an IIFE that attaches itself to
`window.ImageCompressor` (or `self.ImageCompressor` inside a worker). The same
file therefore runs on the main thread **and** inside the worker via
`importScripts('compressor.js')`, which keeps browser support as wide as
possible. No modules, no bundler, no build step.

| Stage | What happens |
| --- | --- |
| Validate | Check the MIME type and size. Reject anything that is not JPG/PNG/WebP. |
| Decode | `createImageBitmap`, falling back to an `<img>` element on the main thread. |
| Guard | Refuse images over 80 MP or wider than 16384 px, with a clear message. |
| Draw | Scale onto a canvas. For JPG, flatten any alpha onto white. |
| Encode | See below. |
| Report | Progress callbacks, plus a result carrying bytes, dimensions and format notes. |

**JPG and WebP** use the browser's own `canvas.toBlob()` encoder with a
quality value.

**PNG** is written from scratch, because the browser can only ever emit a
lossless PNG and shrinking one needs a real quantiser:

1. Build a 5-bit-per-channel RGBA histogram (32768 cells).
2. Median-cut to find a palette, then refine it with Lloyd iterations.
3. Map pixels to the nearest palette colour using a 32768-cell lookup grid, with
   Floyd–Steinberg dithering when the palette is small (≤64 colours).
4. Filter the scanlines adaptively, trying five PNG filters per row and keeping
   the one with the smallest sum of absolute differences.
5. Assemble `IHDR`, `PLTE`, `tRNS`, `IDAT` and `IEND` by hand, with CRC-32 on
   every chunk, deflating the pixel data with the browser's native
   `CompressionStream('deflate')`.

A lossless fast path handles greyscale PNGs (colour type 0, bit depths 1, 2, 4
and 8) by re-encoding at the smallest sufficient depth.

Quality maps to a palette size with `colorsForQuality(q) = clamp(2^(2+6q), 4, 256)`,
snapped to a ladder of sensible palette sizes. `qualityForColors()` is the exact
inverse, so a PNG result reports a meaningful quality number rather than a
placeholder.

**Target size** uses a bounded binary search over the quality axis, keeping the
best result that fits under the target. It stops early rather than degrade an
image into uselessness, and reports `significantLoss` when it had to stop.

**ZIP** archives are written by hand with the STORE method and a CRC-32 per
entry, because there is no compression needed and the data is already sitting in
memory as Blobs.

### `js/worker.js`

A classic Web Worker. It loads the engine with `importScripts`, then reports back
over `postMessage`. Blobs are cloneable but **not** transferable, so they are
sent in the message payload and never in the transfer list — getting that wrong
raises a `DataCloneError` and hangs the UI. Every exit path, including an
unexpected rejection inside `onmessage`, reports back rather than failing
silently, because a rejected promise inside a worker never fires `worker.onerror`.

If the worker cannot be created or crashes, `js/app.js` falls back to running the
engine on the main thread and carries on.

### `js/app.js` — the interface

Holds the file queue, renders the list and results, reads the settings, drives
the worker, and creates the downloads. Every result is a `Blob` held in memory;
nothing is written anywhere.

---

## Before you publish — replace the placeholders

The repository is not tied to any one domain. These placeholder values must be
replaced with your own before you publish.

| Placeholder | Where it appears | Replace with |
| --- | --- | --- |
| `https://www.example.com/` | `index.html`, `privacy.html`, `terms.html`, `about.html`, `contact.html` (canonical link, `og:url`, `og:image`, `twitter:image`, JSON-LD `@id` and `url`), and `sitemap.xml` | Your real site root, with a trailing slash, e.g. `https://username.github.io/repo-name/` |
| `hello@example.com` | `contact.html` (`mailto:` link and visible address) | A real mailbox you control |
| `example.com` (bare) | `robots.txt` and `contact.html` comments | Your host |

A reliable way to do the first one across every file at once:

```powershell
# Run from the project folder. Replace BOTH values.
$root = "https://username.github.io/repo-name/"
$mail = "you@yourdomain.com"

Get-ChildItem -Path . -Include *.html,*.xml,*.txt -Recurse |
  ForEach-Object {
    $c = Get-Content $_.FullName -Raw
    $c = $c.Replace("https://www.example.com/", $root)
    $c = $c.Replace("hello@example.com", $mail)
    Set-Content -Path $_.FullName -Value $c -NoNewline
  }
```

Then check nothing was missed:

```powershell
Select-String -Path *.html,*.xml,*.txt -Pattern 'example\.com'
```

It should return nothing. Confirm the same in `index.html` and `sitemap.xml`
that the trailing slash is present on the site root, since a mismatch between
the canonical URL and the sitemap is a common source of indexing trouble.

---

## Deploy to GitHub Pages

### 1. Create the repository

```powershell
cd "C:\Users\manik\OneDrive\Documents\Default Project"

git init
git add .
git status
```

Confirm `git status` lists only the files you intend to publish, and **not** a
`test-fixtures/` folder or any scratch files. Add a `.gitignore` if you keep
local test images:

```gitignore
test-fixtures/
.DS_Store
Thumbs.db
```

Commit and push:

```powershell
git commit -m "Free image compressor: browser-only JPG/PNG/WebP compression"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Replace `YOUR-USERNAME` and `YOUR-REPO` with your own. If `git remote add origin`
says the remote already exists, use `git remote set-url origin ...` instead.

### 2. Turn on GitHub Pages

1. Open the repository on GitHub.
2. **Settings** → **Pages**.
3. Under *Build and deployment*, set **Source** to **Deploy from a branch**.
4. Under *Branch*, choose **main** and **/(root)**.
5. Click **Save**.

GitHub publishes the site and shows the URL, which looks like:

```
https://YOUR-USERNAME.github.io/YOUR-REPO/
```

That takes a minute or two the first time. Every link in the site is relative,
so nothing needs changing for this URL.

### 3. Check the live site

- The tool loads and the waiting message appears.
- Compressing an image works end to end.
- `https://YOUR-USERNAME.github.io/YOUR-REPO/robots.txt` and
  `.../sitemap.xml` both load.
- Submit the sitemap in **Settings** → **Pages** → *Custom domain* section, or
  through Google Search Console.

---

## Add a custom domain later

You can attach a domain after the site is already live on GitHub Pages.

1. **Settings** → **Pages** → **Custom domain**: enter the apex domain, for
   example `example.org`. Tick **Enforce HTTPS**. Save, and wait for the
   certificate to be issued. This usually takes from a minute to a few hours.
2. At your DNS provider, add the records GitHub shows on that page. Typically:

   | Type | Name | Value |
   | --- | --- | --- |
   | `A` | `@` | `185.199.108.153` |
   | `A` | `@` | `185.199.109.153` |
   | `A` | `@` | `185.199.110.153` |
   | `A` | `@` | `185.199.111.153` |
   | `AAAA` | `@` | `2606:50c0:8000::153` |
   | `AAAA` | `@` | `2606:50c0:8001::153` |
   | `AAAA` | `@` | `2606:50c0:8002::153` |
   | `AAAA` | `@` | `2606:50c0:8003::153` |
   | `CNAME` | `www` | `YOUR-USERNAME.github.io` |

   Also add a `TXT` record for `_github-pages-challenge-YOUR-USERNAME` with the
   value GitHub displays, to prove the domain is yours.
3. Set **Enforce HTTPS** once DNS has resolved, so visitors cannot land on the
   insecure origin.
4. Update the placeholders in every HTML file and in `sitemap.xml` to
   `https://yourdomain.org/`, using the method
   [above](#before-you-publish--replace-the-placeholders). Do this in the same
   commit that the domain starts serving, or search results will briefly show
   the old URL.
5. Update the sitemap in Google Search Console to the new domain.

GitHub serves the site from the `docs/` folder, the branch you selected, or the
root — whichever you chose in step 2. A custom domain changes the URL, not the
file layout, so nothing else needs touching.

---

## Editing the advertisement placeholders

There are three reserved areas, and **no real ads are loaded**:

| `data-ad-slot` | Position |
| --- | --- |
| `above-content` | above the main content, under the header |
| `before-faq` | between the tool and the FAQ |
| `below-faq` | after the FAQ |

Each is an `<aside class="ad-slot">` wrapped in an HTML comment explaining that
it is safe to delete. To remove one, delete the whole element. To add a real ad
later, replace the element's contents with the ad network's snippet. Never place
an ad inside the upload button or immediately beside a download button.

If you do add an ad network, update `privacy.html` **before** it goes live, since
that page currently states there is no advertising code. It already contains the
wording to use.

---

## Testing checklist

Run through this before each deploy.

### Basic flow

- [ ] Page loads with no console errors.
- [ ] Waiting state reads "Waiting for image".
- [ ] Choose a JPG, PNG and a WebP in turn; each is accepted.
- [ ] Original size is shown for each file.
- [ ] Compressing produces a result with a compressed size and a percentage saved.
- [ ] Download saves a file that opens correctly in an image viewer.

### Quality

- [ ] Slider runs 10 → 100, defaults to 80, and the value updates live.
- [ ] Low quality gives a visibly smaller file than high quality.
- [ ] PNG output at 100 / 80 / 50 / 20 produces fewer colours as quality drops.
- [ ] Changing the slider marks previous results as needing a re-run.
- [ ] Output format selector switches between keep / JPG / PNG / WebP.

### Results

- [ ] Single image shows side-by-side before/after previews on desktop.
- [ ] Both previews stack vertically on a narrow screen.
- [ ] Saved percentage is correct.
- [ ] A PNG → JPG conversion with transparency warns before it happens.
- [ ] photo → PNG is reported honestly as a larger file when it grows.

### Target size

- [ ] All seven target options are present: original, 50 KB, 100 KB, 200 KB,
      500 KB, 1 MB, custom.
- [ ] Choosing custom reveals the byte input.
- [ ] A reachable target produces a file at or under the target.
- [ ] An unreachable target says: "The requested size could not be reached
      without significant quality loss. Try a larger target size or reduce the
      image dimensions."
- [ ] No state ever claims an exact size was guaranteed.

### Edge cases

- [ ] A `.txt` file is rejected with: "Unsupported file type. Please choose a
      JPG, PNG or WebP image."
- [ ] A 0-byte file is rejected with a message about the file being empty.
- [ ] A corrupt file with a valid extension fails with "This file could not be
      read as an image", **not** an internal error message.
- [ ] A 17-megapixel image shows a large-image warning and still processes.
- [ ] A 90-megapixel image is refused with an explanation, and the tab survives.
- [ ] A 3×2 image processes without error.
- [ ] Cancelling mid-run stops cleanly: the spinner stops, the button is
      re-enabled, and the status explains how far it got.
- [ ] Per-file Remove and Remove all both reset to the waiting state.
- [ ] Recompress re-runs one file and updates its row.

### Multiple images

- [ ] Four files show as a list with Original / Compressed / Saved / Action.
- [ ] Each row has its own Download and Recompress.
- [ ] Download All produces a ZIP that opens and whose four files are intact.
- [ ] Per-file download and the ZIP contents are byte-identical.

### Privacy

- [ ] With the network panel open, a full upload → compress → download cycle
      shows only `GET` requests for the site's own static files, plus `blob:`
      URLs. No `POST`, no `PUT`, no XHR, no WebSocket, no request body.
- [ ] `localStorage`, `sessionStorage` and cookies stay empty.
- [ ] Closing the tab discards everything.

### Responsive and accessibility

- [ ] No horizontal scrolling at 360 px, 400 px, 620 px, 768 px and 1280 px.
- [ ] At 900 px and wider, the settings and the **Compress** button are on screen
      at the same time as the drop zone, without scrolling.
- [ ] At 768 px and narrower, the two tool columns stack in the order
      upload → files → settings → result.
- [ ] Finishing a run scrolls the result into view.
- [ ] All controls are reachable and usable with one hand on a phone.
- [ ] The skip link is the first thing a keyboard reaches and moves focus to
      the tool.
- [ ] Every control shows a visible focus ring when tabbed to.
- [ ] Every image has alt text; every button has an accessible name.
- [ ] Status changes are announced politely.
- [ ] Dark mode renders with readable contrast.
- [ ] Reduced-motion preference disables animation.

### Deployment

- [ ] `example.com` and `example.com` email are fully replaced.
- [ ] `robots.txt` and `sitemap.xml` load over HTTP.
- [ ] The sitemap lists the real domain.
- [ ] `404.html` is served for a missing path.
- [ ] Every internal link resolves.

---

## Browser support

Targets current Chrome, Edge, Firefox and Safari, on desktop and mobile.

| Feature | Used for | If missing |
| --- | --- | --- |
| `createImageBitmap` | Decoding in the worker | Falls back to an `<img>` element on the main thread |
| Canvas `toBlob` | JPG and WebP encoding | Required; the browser is not supported |
| `CompressionStream` | PNG deflate | A valid stored-deflate stream is used instead |
| Web Worker | Keeping the page responsive | The engine runs on the main thread |
| `URL.createObjectURL` | Previews and downloads | Required |

`CompressionStream` is why the PNG output can be smaller without a third-party
deflate implementation, and the stored-deflate fallback means PNG still works on
browsers that lack it, just with a slightly larger file.

---

## Privacy verification

This is how the no-upload claim was checked, and how to re-check it after any
change.

1. Open the site in a browser with the network panel recording, filtering to
   all requests.
2. Upload a JPG, compress it, and download the result.
3. Confirm the only requests are `GET`s for the site's own HTML, CSS, JavaScript
   and images, plus two `blob:` URLs. There must be no `POST`, `PUT`, `PATCH` or
   `DELETE`, no XHR or fetch with a body, and no WebSocket.
4. Repeat on a second file to be sure a second pass adds nothing new.
5. Check **Application → Storage** in developer tools: `localStorage`,
   `sessionStorage`, `IndexedDB` and cookies should all be empty.

To audit the source:

```powershell
Select-String -Path js\*.js -Pattern 'fetch\(|XMLHttpRequest|WebSocket|sendBeacon|FormData'
Select-String -Path js\*.js -Pattern 'localStorage|sessionStorage|indexedDB|document\.cookie|caches\.'
```

Every hit should be inside a comment stating that the thing is absent. If a real
call ever appears there, the privacy guarantee is broken.

---

## Troubleshooting

**The worker never starts and everything runs slowly.**
Check the console. If the worker file 404s, `js/compressor.js` is probably
missing or was renamed. The app falls back to the main thread, so compression
still works but the page will stutter on large images.

**A download will not open.**
For a ZIP, test it with any archive tool. If it is damaged, check
`zipStore` in `js/compressor.js`: there must be exactly **one** local file
header per entry, with the data following it as one contiguous run. Writing a
header per 64 KB chunk corrupts every entry larger than the chunk.

**PNG output is bigger than the input.**
Expected for a detailed photograph: PNG is lossless, so a photo encoded as PNG
is normally larger. The tool reports this honestly rather than hiding it. Use
JPG or WebP for photographs.

**A target size is never reached.**
Intended. The search stops once quality would drop below the point of visible
damage, and says so. Ask for a larger target, or set a resize limit.

**The site looks unstyled after editing the CSS.**
A stray unbalanced brace will kill the rest of the stylesheet. Validate the file
in an editor or run it through a CSS validator.

**Images do not appear in the previews.**
`assets/` must sit next to the HTML files. Paths are relative, so keep the
folder structure intact when deploying.
