package org.prismos.play;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.annotation.Nullable;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PluginCall;

/**
 * The Capacitor 7 host activity for 《光影Play》 (appId org.prismos.play, appName 光影Play).
 *
 * Two jobs, both of which really belong to an activity rather than to a plugin: (1) hold the window and
 * therefore every window-scoped effect the bridge promises (AC-02-4 FLAG_SECURE, AC-07 screenBrightness,
 * AC-10 FLAG_KEEP_SCREEN_ON), and (2) make the window punch-hole-correct so the CSS safe-area rules in
 * SPEC 10 have something honest to read. PrismNative reaches these through package-private methods, and
 * each of them resolves its own PluginCall from the main thread, because Capacitor dispatches plugin
 * calls on Bridge.taskHandler while WindowManager refuses to be touched off the UI thread.
 *
 * NOTHING HERE HAS EVER RUN: this machine has no JDK, Gradle or Android SDK.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // App-module plugins are absent from assets/capacitor.plugins.json (that file only carries npm
        // plugins discovered by the CLI), so the class must be handed to the Bridge.Builder BEFORE
        // super.onCreate() builds the Bridge; after that the builder has already been consumed.
        registerPlugin(PrismNativePlugin.class);
        // AC-24 DLNA cast, same in-module pattern (SPEC §1.5.2.2): no capacitor.settings.gradle entry and no
        // plugins.json entry, because neither is consulted for classes that live in this app module.
        registerPlugin(PrismCastPlugin.class);
        super.onCreate(savedInstanceState);
        applyDisplayCutoutMode();
    }

    /**
     * SPEC 10 / ARCHITECTURE 1.1 (historical defect 1): the WebView must extend into the notch area so
     * that env(safe-area-inset-top) reports the real inset instead of the app being letterboxed under a
     * black band.
     *
     * Applied programmatically because BridgeActivity.onCreate overwrites the activity theme with the
     * library's own AppTheme.NoActionBar before this method runs, so a windowLayoutInDisplayCutoutMode
     * item in res/values/styles.xml is silently dropped at runtime. If the Chief Builder prefers the
     * resource route it belongs in res/values-v27/styles.xml (outside the Stage 3 file set) and this
     * method should then be deleted, not kept alongside. targetSdk 35 already forces edge-to-edge
     * layout, so the cutout mode is the only remaining job here. Whether a specific punch-hole device
     * still overlaps the top bar, and how the nav bar contrasts under the ivory theme, stay real-device
     * questions (device checklist item 6).
     */
    private void applyDisplayCutoutMode() {
        if (getWindow() == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
            return;
        }
        try {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        } catch (RuntimeException ex) {
            // A few OEM windows refuse the attribute; never block startup over an inset.
            Logger.error("PrismMain: cutout mode refused", ex);
        }
    }

    // Window-scoped bridge effects, called by PrismNativePlugin --------------------------------------

    /** AC-07: read the window override. A negative value means "follow the system". */
    void readBrightness(PluginCall call) {
        runOnUiThread(() -> call.resolve(brightnessPayload(windowAttributes().screenBrightness)));
    }

    /**
     * AC-07: write the window override. Brightness multiplies the system backlight and some devices hold
     * a floor, so the answer reports what the window now says rather than echoing the request.
     */
    void writeBrightness(PluginCall call, @Nullable Float requested) {
        if (requested == null) {
            call.reject("缺少亮度值", "ARGUMENT_REQUIRED");
            return;
        }
        final float clamped = clamp01(requested);
        runOnUiThread(() -> {
            WindowManager.LayoutParams attributes = windowAttributes();
            attributes.screenBrightness = clamped;
            getWindow().setAttributes(attributes);
            call.resolve(brightnessPayload(attributes.screenBrightness));
        });
    }

    /**
     * AC-02-4: mount or release FLAG_SECURE for the 个人探索 window. The returned boolean only proves the
     * flag is set on THIS window; it cannot stop an external camera and does not exist on the web build,
     * which is precisely the limitation AC-02-4 requires us to publish.
     */
    void toggleSecureScreen(PluginCall call, @Nullable Boolean enabled) {
        if (enabled == null) {
            call.reject("缺少参数 enabled", "ARGUMENT_REQUIRED");
            return;
        }
        runOnUiThread(() -> {
            int flag = WindowManager.LayoutParams.FLAG_SECURE;
            applyFlag(flag, enabled);
            boolean applied = (windowAttributes().flags & flag) != 0;
            call.resolve(new JSObject().put("value", applied == enabled.booleanValue()));
        });
    }

    /** AC-10 companion: keep the panel lit while the user is watching, off when they leave. */
    void toggleKeepScreenOn(PluginCall call, @Nullable Boolean enabled) {
        if (enabled == null) {
            call.reject("缺少参数 enabled", "ARGUMENT_REQUIRED");
            return;
        }
        runOnUiThread(() -> {
            applyFlag(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON, enabled);
            call.resolve();
        });
    }

    private boolean immersive = false;
    private int priorUi, priorOrientation, priorBehavior;
    private boolean priorStatus, priorNavigation;

    void toggleImmersive(PluginCall call, @Nullable Boolean enabled) {
        if (enabled == null) { call.reject("缺少参数 enabled", "ARGUMENT_REQUIRED"); return; }
        runOnUiThread(() -> {
            try {
                if (enabled && !immersive) {
                    priorUi = getWindow().getDecorView().getSystemUiVisibility();
                    priorOrientation = getRequestedOrientation();
                    if (Build.VERSION.SDK_INT >= 30) {
                        android.view.WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
                        priorStatus = insets == null || insets.isVisible(android.view.WindowInsets.Type.statusBars());
                        priorNavigation = insets == null || insets.isVisible(android.view.WindowInsets.Type.navigationBars());
                        priorBehavior = getWindow().getInsetsController().getSystemBarsBehavior();
                    }
                    immersive = true;
                    hideBars();
                } else if (!enabled) restoreBars();
                call.resolve(new JSObject().put("value", true));
            } catch (RuntimeException error) {
                restoreBars(); call.reject("系统栏切换失败", "IMMERSIVE_FAILED", error);
            }
        });
    }

    private void hideBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            controller.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(android.view.WindowInsets.Type.systemBars());
        } else getWindow().getDecorView().setSystemUiVisibility(priorUi
                | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    private void restoreBars() {
        if (!immersive) return;
        immersive = false;
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            controller.setSystemBarsBehavior(priorBehavior);
            if (priorStatus) controller.show(android.view.WindowInsets.Type.statusBars());
            else controller.hide(android.view.WindowInsets.Type.statusBars());
            if (priorNavigation) controller.show(android.view.WindowInsets.Type.navigationBars());
            else controller.hide(android.view.WindowInsets.Type.navigationBars());
        } else getWindow().getDecorView().setSystemUiVisibility(priorUi);
        setRequestedOrientation(priorOrientation);
    }

    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus && immersive) hideBars();
    }
    @Override protected void onDestroy() { restoreBars(); super.onDestroy(); }

    private void applyFlag(int flag, boolean on) {
        if (on) {
            getWindow().addFlags(flag);
        } else {
            getWindow().clearFlags(flag);
        }
    }

    private WindowManager.LayoutParams windowAttributes() {
        return getWindow().getAttributes();
    }

    private static JSObject brightnessPayload(float raw) {
        // No platform API exposes the true panel backlight from a window, so "following the system" is
        // reported explicitly instead of inventing a number: the UI can then say it is at system level.
        return new JSObject()
                .put("brightness", raw < 0d ? 1d : (double) raw)
                .put("supported", true)
                .put("followingSystem", raw < 0d);
    }

    private static float clamp01(float value) {
        return value < 0f ? 0f : (value > 1f ? 1f : value);
    }
}
