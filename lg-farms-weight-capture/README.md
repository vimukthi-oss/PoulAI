# LG Farms — broiler weight calibration capture

An offline Android app for pairing a photograph of a bird with the weight the
scale actually read. It exists to build the training set for camera-based weight
estimation. It does **not** estimate weight itself — that comes later, once
there is data to fit a curve to.

One supervisor, one phone, one printed marker board. No network, no login,
no server.

---

## What it produces

Everything lands in `Downloads/LG Farms/weights/<date>_h<house>_d<age>/`:

```
h2_d21_2026-10-04_0001_845g.jpg
h2_d21_2026-10-04_0002_912g.jpg
...
2026-10-04_h2_d21_weights.csv
```

The weight is in the filename **and** in the CSV, deliberately. If the CSV is
lost, the dataset is still intact. If a folder is copied to a pen drive and
back, nothing can silently separate a bird from its weight.

### CSV columns

| column | meaning |
|---|---|
| `session_id` `house` `batch` `age_days` `date` | session header, repeated per row |
| `board_id` `marker_mm` | which board, and its **measured** printed size |
| `seq` `weight_g` `filename` | the bird |
| `marker_found` `marker_id` | 1/0, and the id actually detected |
| `marker_px` | mean marker side length in the saved image |
| `mm_per_px` | scale at the board surface = `marker_mm / marker_px` |
| `skew` | longest marker side ÷ shortest; > 1.15 means the phone was tilted |
| `img_w` `img_h` | saved image size |
| `det_scale` | the downscale factor detection succeeded at (1 = full res) |
| `captured_at` | ISO timestamp |

**`mm_per_px` doubles as the camera-height record.** The marker's apparent size
falls off with distance, so for a given phone `mm_per_px` is proportional to how
high it was held. Bird area in mm² is `pixel_area × mm_per_px²`; the residual
magnification from the bird's back sitting above the board is a function of the
same quantity. Put `mm_per_px` in the regression as a covariate and the height
effect is absorbed — no camera calibration needed.

A low `det_scale` (0.375, 0.25) means the image was noisy enough that detection
only worked after heavy downscaling. Those rows are usable but slightly less
precise; filter them out if you have plenty of data.

---

## Using it

1. Print `markers/lg-farms-calibration-marker.pdf` at **100% / Actual size**.
   Measure the black square with a steel rule and enter the real number in the
   app — not 150 unless it really is 150.
2. Mount the sheet flat on rigid board, cover with matte tape or lamination.
3. New session → house, batch, age in days, board, measured marker size.
4. Board flat on the floor or mat, marker at one end, bird in the middle.
5. **Weigh first, photograph second.** A weight with no photo is just your normal
   record; a photo with no weight is useless.
6. Phone directly overhead, flat, whole marker and whole bird in frame. Shoot.
   Type the grams. Save.
7. Finish & write CSV at the end of the session.
8. Plug into the PC, copy the whole folder off.

The chip on the viewfinder is green only when the marker is locked, the board id
matches, and the phone is not tilted. Capture is never blocked — a bird that will
not sit still is worth a flagged photo — but flagged rows are counted on the
review screen.

---

## Build

The APK was **not** compiled here; Google's Maven repositories are unreachable
from the build sandbox. Three routes, easiest first:

**GitHub Actions (no local tooling).** Push this folder to a repository. The
included workflow builds a debug APK on every push; download it from the run's
artifacts. Use `workflow_dispatch` to trigger manually.

**Android Studio.** Open the folder, let it sync, Run. It will generate the
Gradle wrapper and fetch the SDK itself.

**Command line.** Needs JDK 17 and the Android SDK:

```
gradle wrapper --gradle-version 8.7
./gradlew assembleDebug
```

A debug APK installs fine via sideload — "Install unknown apps" must be allowed
for whatever app opens the file. For a release build you need a signing keystore;
**back that keystore up**, because losing it means no future updates to an
installed app.

## Run it in the browser first

`app/src/main/assets/www/` is a working web app on its own. Served over https
(or localhost) it runs in Chrome on Android with the camera and marker detection
fully functional. Without the native shell it saves each image through the
browser's download mechanism instead of writing directly — Chrome asks once to
allow multiple downloads. That is enough to start collecting real data before
any APK exists.

---

## Design notes

**Multi-scale detection.** A broiler house at 10 lux forces the phone's gain up,
and the sensor noise that follows breaks ArUco detection at full resolution.
Bench tests against simulated low-light noise: full resolution failed where half
resolution plus a light blur succeeded, and very noisy frames only resolved at
0.375 scale. So capture runs a cascade — full res, full res blurred, half, half
blurred, 0.375, 0.25 — and stops at the first hit, mapping corners back to full
image coordinates. Scale-back costs about 0.7% in measured marker size, which is
recorded rather than hidden. Frames beyond that are genuinely unrecoverable and
correctly report "no marker".

**Images are written on save, one at a time.** Holding a session in memory and
writing at the end means one crash costs the morning. The worst case here is
losing the single bird in progress.

**Deleting a row does not delete the file.** Removing files from shared storage
needs extra permission and the orphan is harmless; the CSV is the source of truth.

**Marker ids are 4×4 dictionary, first 50 codes** — identical to OpenCV's
`DICT_4X4_50`, verified against `cv2.aruco`. So anything you write on the PC
with OpenCV will read these markers with no translation.

---

## Limits

- No server copy. A lost phone loses that session. Copy the folder off after
  every session rather than letting a cycle accumulate.
- Images are downscaled to 1600 px on the long edge (~400 KB). Far more than
  segmentation needs, and a full cycle stays under a gigabyte.
- Saved images are JPEG at quality 0.85. Fine for area measurement; if you later
  want lossless, that is a one-line change and roughly 4× the storage.
- `skew` is a crude tilt proxy from side-length ratio, not a real pose solve.
  It catches gross tilt, which is what matters.

## Third-party

Marker detection is [js-aruco2](https://github.com/damianofalcioni/js-aruco2)
(MIT), with the 4×4 dictionary trimmed to the first 50 codes. Licence text is in
`app/src/main/assets/www/lib/`.
