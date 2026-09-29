# Getting the app onto the phone

Two routes. The first needs no build tooling and takes about five minutes.

---

## Route A — host it, then install from the browser (recommended)

The `pages/` folder is a complete installable web app: one HTML file, an icon,
a manifest and a service worker. Once installed it runs fully offline.

1. Create a new **public** repository on GitHub.
2. Upload the contents of this project (or just the `pages/` folder).
3. Repo → **Settings** → **Pages** → Source: **GitHub Actions**.
   The included `pages.yml` workflow publishes `pages/` automatically on push.
   (If you prefer, set Source to *Deploy from a branch* and point it at the
   folder directly — either works.)
4. Wait for the green tick under the **Actions** tab, then open the URL it
   prints — `https://<user>.github.io/<repo>/` — on the Android phone in Chrome.
5. Tap **Start session**. Chrome asks for the camera. Tap **Allow**.
6. Chrome menu → **Add to Home screen**. You now have a launcher icon that
   opens without browser chrome and works with no signal.

Images save through Chrome's download mechanism into `Downloads/`. Chrome asks
once to permit multiple downloads per session; tap Allow.

**This is enough to start collecting data.** The APK below only changes where
files are written, not what is collected.

---

## Route B — build the APK

The APK writes images straight into `Downloads/LG Farms/<session>/` in tidy
per-session folders, rather than dropping them loose in `Downloads/`. Worth
having eventually; not worth waiting for.

**Via GitHub Actions (no local tooling):** push this project to a repository.
`android.yml` builds a debug APK on every push. Actions tab → latest run →
**Artifacts** → `lg-weight-capture-apk`. Transfer to the phone and tap to
install; Android will ask you to permit installs from that source.

**Via Android Studio:** open the project folder, let it sync, press Run.

**Via command line** (JDK 17 + Android SDK):

```
gradle wrapper --gradle-version 8.7
./gradlew assembleDebug
```

A debug APK is signed with a throwaway debug key — fine for your own phones.
For a release build you need your own keystore, and **you must back that
keystore up**: lose it and you cannot ship an update to an installed app.

---

## Which files matter

| path | what it is |
|---|---|
| `pages/` | the installable web app — Route A deploys this |
| `app/src/main/assets/www/` | the same app, unbundled, as Android assets |
| `app/src/main/java/.../MainActivity.java` | the native shell and file-writing bridge |
| `markers/` | the printable calibration marker |
