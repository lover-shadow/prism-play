package org.prismos.play;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import org.json.JSONObject;

/**
 * The Android half of the PrismNative bridge declared in src/core/native/bridge.ts. Plugin id, method
 * names and the "callState" event name are the frozen integration surface, and a mismatch is only
 * visible on a phone, so the wire shape is pinned here for the TypeScript adapter.
 *
 * Capacitor passes ONE object per call and resolves ONE object back, so bridge.ts's positional calls map
 * to secureRead/secureClear({ key }), secureWrite({ key, value }), setBrightness/setSystemVolume
 * ({ value }), setSecureScreen/setKeepScreenOn({ enabled }), startBackgroundAudio({ title, episodeLabel
 * }), openExternalUrl({ url }); isKeystoreBacked/getBrightness/getSystemVolume take nothing. The adapter
 * unwraps .value for the string|null and boolean returns, reads .brightness/.volume/.supported directly,
 * and the callState payload is { state: 'idle' | 'ringing' | 'offhook' }.
 *
 * Window effects are delegated to MainActivity, which owns the window and resolves from the UI thread:
 * Capacitor runs plugin methods on Bridge.taskHandler and WindowManager refuses other threads.
 * NOTHING HERE HAS EVER RUN: this machine has no JDK, Gradle or Android SDK. Review-only.
 */
@CapacitorPlugin(
        name = PrismNativePlugin.PLUGIN_ID,
        // Aliases, not bare strings: TS can then use the inherited checkPermissions()/requestPermissions()
        // to ask for POST_NOTIFICATIONS (AC-10) and READ_PHONE_STATE (AC-11) with no contract change.
        permissions = {
                @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"}),
                @Permission(alias = "phoneState", strings = {"android.permission.READ_PHONE_STATE"})
        }
)
public final class PrismNativePlugin extends Plugin {

    static final String PLUGIN_ID = "PrismNative";
    static final String EVENT_CALL_STATE = "callState";

    /** Which Domain 1 key holds the bearer token the privileged proxy may attach. */
    private static final String DEFAULT_AUTHORIZATION_KEY = "jwt";

    private static final int OP_READ = 0;
    private static final int OP_WRITE = 1;
    private static final int OP_CLEAR = 2;

    @Nullable
    private SecureCredentialStore credentials;
    @Nullable
    private CallStateReceiver callStateReceiver;

    @Override
    public void load() {
        credentials = SecureCredentialStore.open(getContext());
        callStateReceiver = new CallStateReceiver(this::emitCallState);
        // Off unless capacitor.config.ts says otherwise: SPEC 5 keeps private streaming closed until
        // per-sub-request admission is proven on hardware, and PrivilegedServerProxy holds that gate.
        boolean proxyEnabled = getConfig().getBoolean(PrivilegedServerProxy.CONFIG_FLAG, false);
        PrivilegedServerProxy.configure(proxyEnabled, this::authorizationForProxy);
        if (proxyEnabled && getBridge() != null) {
            getBridge().setWebViewClient(new PrivilegedServerProxy(getBridge(), getBridge().getHost()));
        }
        // Notification buttons have no other route to the media element.
        PlaybackService.setCommandListener(this::onNotificationCommand);
    }

    @PluginMethod
    public void secureRead(PluginCall call) { credential(call, OP_READ); }

    @PluginMethod
    public void secureWrite(PluginCall call) { credential(call, OP_WRITE); }

    @PluginMethod
    public void secureClear(PluginCall call) { credential(call, OP_CLEAR); }

    @PluginMethod
    public void getBrightness(PluginCall call) { withWindow(call, MainActivity::readBrightness); }

    @PluginMethod
    public void setBrightness(PluginCall call) {
        withWindow(call, (host, inner) -> host.writeBrightness(inner, inner.getFloat("value")));
    }

    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        withWindow(call, (host, inner) -> host.toggleSecureScreen(inner, inner.getBoolean("enabled")));
    }

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        withWindow(call, (host, inner) -> host.toggleKeepScreenOn(inner, inner.getBoolean("enabled")));
    }

    @PluginMethod
    public void setImmersiveMode(PluginCall call) {
        withWindow(call, (host, inner) -> host.toggleImmersive(inner, inner.getBoolean("enabled")));
    }

    @PluginMethod
    public void getSystemVolume(PluginCall call) { volume(call, null, false); }

    @PluginMethod
    public void setSystemVolume(PluginCall call) { volume(call, call.getFloat("value"), true); }

    @PluginMethod
    public void isKeystoreBacked(PluginCall call) {
        // False is the honest answer whenever the master key did not resolve; the caller must then say so
        // in the UI rather than pretend the credential is hardware protected.
        call.resolve(new JSObject().put("value", credentials != null && credentials.isKeystoreBacked()));
    }

    @PluginMethod
    public void stopBackgroundAudio(PluginCall call) {
        PlaybackService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void startBackgroundAudio(PluginCall call) {
        String title = call.getString("title");
        if (title == null || title.trim().isEmpty()) {
            call.reject("缺少剧名", "ARGUMENT_REQUIRED");
            return;
        }
        PlaybackService.start(getContext(), title, call.getString("episodeLabel"));
        call.resolve();
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.trim().toLowerCase().startsWith("https://")) {
            // Only an absolute TLS URL leaves the sandbox: a crafted /api/version payload must not be able
            // to aim the phone at file://, intent:// or javascript:// handlers.
            call.reject("仅允许 https 直链", "URL_NOT_ALLOWED");
            return;
        }
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (ActivityNotFoundException ex) {
            call.reject("设备上没有可打开该链接的应用", "NO_ACTIVITY", ex);
        }
    }

    @Override
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void addListener(PluginCall call) {
        // Re-annotated on purpose: PluginHandle.indexMethods walks getMethods() of the concrete class and
        // Java does not inherit method annotations, so an un-annotated override would delete the
        // addListener entry point entirely and callState could never be subscribed.
        super.addListener(call);
        if (EVENT_CALL_STATE.equals(call.getString("eventName")) && callStateReceiver != null) {
            callStateReceiver.register(getContext());
        }
    }

    @Override
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void removeListener(PluginCall call) {
        super.removeListener(call);
        if (!hasListeners(EVENT_CALL_STATE) && callStateReceiver != null) {
            callStateReceiver.unregister(getContext());
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (callStateReceiver != null) {
            callStateReceiver.unregister(getContext());
        }
        // Detach before the Bridge dies: a later notification tap must not evaluate JavaScript against a
        // destroyed WebView, so the buttons go inert until the host returns instead of faking success.
        PlaybackService.setCommandListener(null);
        super.handleOnDestroy();
    }

    private void emitCallState(String state) {
        notifyListeners(EVENT_CALL_STATE, new JSObject().put("state", state));
    }

    private void credential(PluginCall call, int operation) {
        String key = call.getString("key");
        String value = operation == OP_WRITE ? call.getString("value") : null;
        if (key == null || credentials == null || (operation == OP_WRITE && value == null)) {
            call.reject("缺少凭证参数或安全存储不可用", "ARGUMENT_REQUIRED");
            return;
        }
        try {
            if (operation == OP_READ) {
                String stored = credentials.read(key);
                // JSONObject.NULL, not Java null: JSObject.put(name, null) deletes the key and the caller
                // would see undefined where bridge.ts promises string | null.
                call.resolve(new JSObject().put("value", stored == null ? JSONObject.NULL : stored));
                return;
            }
            if (operation == OP_WRITE) {
                credentials.write(key, value);
            } else {
                credentials.clear(key);
            }
            call.resolve();
        } catch (SecureCredentialStore.CredentialStoreException ex) {
            call.reject(ex.getMessage(), ex.code);
        }
    }

    private void volume(PluginCall call, @Nullable Float requested, boolean mutate) {
        AudioManager audio = audioManager();
        if (audio == null) {
            call.resolve(new JSObject().put("volume", 1d).put("supported", false));
            return;
        }
        if (mutate && requested == null) {
            call.reject("缺少音量值", "ARGUMENT_REQUIRED");
            return;
        }
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (requested != null) {
            // FLAG_SHOW_UI deliberately unset: AC-06 draws its own 冰蓝 HUD, and the platform volume panel
            // would stack a second, unthemed indicator on top of it.
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(clamp01(requested) * max), 0);
        }
        // Always re-read: the platform may clamp to a floor or report a mute state.
        double normalized = max <= 0 ? 1d : (double) audio.getStreamVolume(AudioManager.STREAM_MUSIC) / max;
        call.resolve(new JSObject().put("volume", normalized).put("supported", true));
    }

    /** What a window effect does once there is a window to do it to. */
    private interface WindowAction {
        void apply(MainActivity host, PluginCall call);
    }

    private void withWindow(PluginCall call, WindowAction action) {
        MainActivity host = host();
        if (host == null) {
            unsupported(call);
            return;
        }
        action.apply(host, call);
    }

    @Nullable
    private MainActivity host() {
        return getActivity() instanceof MainActivity ? (MainActivity) getActivity() : null;
    }

    /** No live window answers "not supported", which is the truth rather than a failure. */
    private void unsupported(PluginCall call) {
        call.resolve(new JSObject().put("brightness", 1d).put("value", false).put("supported", false));
    }

    @Nullable
    private AudioManager audioManager() {
        Context context = getContext();
        return context == null ? null
                : (AudioManager) context.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @Nullable
    private String authorizationForProxy() {
        SecureCredentialStore store = credentials;
        if (store == null || !store.isKeystoreBacked()) {
            return null;
        }
        try {
            return store.read(getConfig().getString("authorizationKey", DEFAULT_AUTHORIZATION_KEY));
        } catch (SecureCredentialStore.CredentialStoreException ex) {
            return null;
        }
    }

    private void onNotificationCommand(String action) {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        String mapped = PlaybackService.ACTION_TOGGLE.equals(action) ? "toggle"
                : PlaybackService.ACTION_NEXT.equals(action) ? "next"
                : PlaybackService.ACTION_PREVIOUS.equals(action) ? "previous" : action;
        if (!mapped.equals("toggle") && !mapped.equals("next") && !mapped.equals("previous")
                && !mapped.equals(PlaybackService.COMMAND_FOCUS_LOST)
                && !mapped.equals(PlaybackService.COMMAND_FOCUS_REGAINED)) return;
        final String script = "window.PrismNativeMedia && window.PrismNativeMedia.onNotificationAction('"
                + mapped + "')";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private static float clamp01(float value) {
        return value < 0f ? 0f : (value > 1f ? 1f : value);
    }
}
