package lk.lgfarms.weightcapture;

import android.Manifest;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Thin native shell around the offline capture web app.
 *
 * The web app is served over https://appassets.androidplatform.net/ rather than
 * file:// so that getUserMedia, IndexedDB and localStorage all behave as they do
 * on a real secure origin.
 */
public class MainActivity extends AppCompatActivity {

    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int REQ_PERMS = 4711;
    /** Everything this app writes lives under Downloads/<ROOT>/ */
    public static final String ROOT = "LG Farms";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Only the bundled app runs here, so granting the camera is safe.
                runOnUiThread(new Runnable() {
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }
        });

        web.addJavascriptInterface(new Bridge(), "LGFarms");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript(
                        "(window.__androidBack && window.__androidBack()) ? 'handled' : 'exit';",
                        value -> {
                            if (value != null && value.contains("exit")) {
                                finish();
                            }
                        });
            }
        });

        requestPerms();
        web.loadUrl(ORIGIN + "/assets/www/index.html");
    }

    private void requestPerms() {
        java.util.List<String> want = new java.util.ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.CAMERA);
        }
        // Scoped storage from API 29 onwards makes WRITE_EXTERNAL_STORAGE unnecessary.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (!want.isEmpty()) {
            ActivityCompat.requestPermissions(this, want.toArray(new String[0]), REQ_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, @NonNull String[] p, @NonNull int[] r) {
        super.onRequestPermissionsResult(code, p, r);
        if (code == REQ_PERMS) {
            web.evaluateJavascript("window.__permsChanged && window.__permsChanged();", null);
        }
    }

    // ---------------------------------------------------------------- bridge

    public class Bridge {

        /**
         * Writes a JPEG into Downloads/LG Farms/<folder>/<name>.
         * Returns the path written, or an empty string on failure.
         */
        @JavascriptInterface
        public String saveImage(String base64, String folder, String name) {
            try {
                byte[] bytes = Base64.decode(stripDataUrl(base64), Base64.DEFAULT);
                return write(bytes, folder, name, "image/jpeg");
            } catch (Exception e) {
                return "";
            }
        }

        /** Writes a text file (CSV, JSON) into the same place. */
        @JavascriptInterface
        public String saveText(String text, String folder, String name, String mime) {
            try {
                return write(text.getBytes(StandardCharsets.UTF_8), folder, name,
                        mime == null || mime.isEmpty() ? "text/plain" : mime);
            } catch (Exception e) {
                return "";
            }
        }

        /** True when the app can write to shared storage right now. */
        @JavascriptInterface
        public boolean canSave() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return true;
            return ContextCompat.checkSelfPermission(MainActivity.this,
                    Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        /** Keeps the screen on during a capture session. */
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }

    private static String stripDataUrl(String s) {
        int i = s.indexOf(',');
        return (s.startsWith("data:") && i > 0) ? s.substring(i + 1) : s;
    }

    /**
     * MediaStore on API 29+, plain files below that.
     *
     * MediaStore silently appends "(1)" when a display name collides, which would
     * break the filename-carries-the-weight scheme, so the caller must supply
     * unique names (the session id plus sequence number does this).
     */
    private String write(byte[] bytes, String folder, String name, String mime) throws Exception {
        String rel = Environment.DIRECTORY_DOWNLOADS + File.separator + ROOT
                + (folder == null || folder.isEmpty() ? "" : File.separator + folder);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            cv.put(MediaStore.MediaColumns.IS_PENDING, 1);

            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) return "";
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) return "";
                out.write(bytes);
                out.flush();
            }
            cv.clear();
            cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(uri, cv, null, null);
            return rel + File.separator + name;
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DOWNLOADS), ROOT
                + (folder == null || folder.isEmpty() ? "" : File.separator + folder));
        if (!dir.exists() && !dir.mkdirs()) return "";
        File f = new File(dir, name);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
            out.flush();
        }
        return f.getAbsolutePath();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("LGFarms");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
