# Firstprint promo video engine

Videos are HTML pages rendered frame by frame (exact timing, 60 fps) with Playwright, then encoded with ffmpeg. Music and sound effects are synthesised from scratch by `gen_audio.py` (no samples, nothing licensed).

The approved look is written down in `STYLE.md`. Follow it for new videos.

## Files

- `x1.js`: video 1, the approved square X cut (kinetic type, token orbit, SOL card, green wipe). Use it as the template for new videos.
- `v1.js` … `v5.js`: the first five videos (vertical 1080×1920; `stage-x.html` turns them into a square cut).
- `lib.js`: motion helpers (easing, keyframes, camera, captions, taps, coins) and Firstprint UI pieces (market card, outcome rows, end card).
- `tokens.js`: token logos as inline SVG (cryptocurrency-icons, CC0; SOL is the official Solana mark).
- `stage-sq.html`: page for natively square videos (`x*.js`). `stage.html` / `stage-x.html`: vertical and square cuts of `v*.js`.
- `banners.html`, `banners.mjs`: the three teaser banners.
- `fonts/`: Geist and Geist Mono (SIL Open Font License).

## Render a video

Needs Node 22, Playwright with Chromium, ffmpeg and Python 3 with numpy. `record.mjs` imports Playwright from `/opt/node-tools/node_modules/playwright`; change that path if yours is elsewhere.

```sh
cd marketing/video
node record.mjs x1 60                         # frames → out-x/firstprint-x1-silent.mp4 and out-x/x1.sfx.json
python3 gen_audio.py out-x/x1.sfx.json out-x/x1.wav
ffmpeg -i out-x/firstprint-x1-silent.mp4 -i out-x/x1.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart firstprint-x-v1.mp4
```

Check single frames first with `node record.mjs x1 60 --stills 2.2,7.0,15.7` (PNG files in `out-x/`).
