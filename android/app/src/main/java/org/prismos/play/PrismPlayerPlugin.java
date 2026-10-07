package org.prismos.play;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;

@UnstableApi
@CapacitorPlugin(name = "PrismPlayer")
public final class PrismPlayerPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<PluginCall> calls = new HashSet<>();
    private final Set<String> usedSessions = new HashSet<>();
    private PrismPlayerSession session;
    private boolean background;
    private volatile boolean destroyed;

    private interface Action { void run(); }

    private void dispatch(PluginCall call, Action action) {
        synchronized (calls) {
            if (destroyed) { call.reject("播放器已关闭", "PLUGIN_DESTROYED"); return; }
            getBridge().saveCall(call);
            calls.add(call);
        }
        if (!main.post(() -> {
            if (destroyed) { settle(call, "PLUGIN_DESTROYED"); return; }
            try { action.run(); }
            catch (IllegalArgumentException error) { settle(call, "INVALID_ARGUMENT"); }
            catch (RuntimeException error) { settle(call, "PLAYER_UNAVAILABLE"); }
        })) settle(call, "PLUGIN_DESTROYED");
    }

    private void settle(PluginCall call, String failure) {
        synchronized (calls) { if (!calls.remove(call)) return; }
        try {
            if (failure == null) call.resolve();
            else call.reject("原生播放操作未完成", failure);
        } finally { getBridge().releaseCall(call); }
    }

    private PrismPlayerSession requireSession(PluginCall call) {
        String id = call.getString("sessionId");
        if (session == null || id == null || !session.id.equals(id)) {
            settle(call, "SESSION_MISMATCH");
            return null;
        }
        return session;
    }

    @PluginMethod public void create(PluginCall call) {
        dispatch(call, () -> {
            String id = call.getString("sessionId");
            if (id == null || id.trim().isEmpty() || id.length() > 128) throw new IllegalArgumentException();
            JSObject bounds = call.getObject("bounds");
            PrismPlayerSurface.validate(bounds);
            if (session != null || usedSessions.contains(id)) {
                settle(call, "SESSION_CONFLICT"); return;
            }
            WebView webView = getBridge().getWebView();
            if (webView == null || getActivity() == null || getActivity().isFinishing()
                    || getActivity().isDestroyed()) { settle(call, "HOST_UNAVAILABLE"); return; }
            PrismPlayerSurface surface = new PrismPlayerSurface(webView, bounds);
            try {
                session = new PrismPlayerSession(id, getContext(), main, surface,
                    payload -> notifyListeners("event", payload), background);
                usedSessions.add(id);
            } catch (RuntimeException error) { surface.close(); throw error; }
            settle(call, null);
        });
    }

    @PluginMethod public void setSource(PluginCall call) {
        dispatch(call, () -> {
            PrismPlayerSession current = requireSession(call);
            if (current == null) return;
            if (call.getData().has("url")) { settle(call, "URL_SOURCE_UNSUPPORTED"); return; }
            String videoId = call.getString("videoId");
            if (videoId == null || !videoId.matches("[0-9]{1,32}")) throw new IllegalArgumentException();
            double position = number(call, "positionSeconds", 0d, 0d, Long.MAX_VALUE / 1000d);
            current.setSource(videoId, position, (ok, failure) -> settle(call, ok ? null : failure));
        });
    }

    @PluginMethod public void setBackgroundAllowed(PluginCall call) {
        Boolean allowed = call.getBoolean("allowed");
        if (allowed == null) { call.reject("缺少后台允许设置", "ARGUMENT_REQUIRED"); return; }
        control(call, current -> current.setBackgroundAllowed(allowed));
    }
    @PluginMethod public void play(PluginCall call) { control(call, current -> current.play()); }
    @PluginMethod public void pause(PluginCall call) { control(call, current -> current.pause()); }
    @PluginMethod public void seek(PluginCall call) {
        control(call, current -> current.seek(number(call, "seconds", null, 0d, Long.MAX_VALUE / 1000d)));
    }
    @PluginMethod public void setVolume(PluginCall call) {
        control(call, current -> current.setVolume((float) number(call, "volume", null, 0d, 1d)));
    }
    @PluginMethod public void setRate(PluginCall call) {
        control(call, current -> current.setRate((float) number(call, "rate", null, 0.1d, 8d)));
    }
    @PluginMethod public void setBounds(PluginCall call) {
        control(call, current -> current.surface.setBounds(call.getObject("bounds")));
    }
    @PluginMethod public void release(PluginCall call) {
        dispatch(call, () -> {
            PrismPlayerSession current = requireSession(call);
            if (current == null) return;
            session = null;
            current.close();
            settle(call, null);
        });
    }

    private interface Control { void run(PrismPlayerSession current); }
    private void control(PluginCall call, Control control) {
        dispatch(call, () -> {
            PrismPlayerSession current = requireSession(call);
            if (current == null) return;
            control.run(current);
            settle(call, null);
        });
    }

    private static double number(PluginCall call, String key, Double fallback, double min, double max) {
        Object raw = call.getData().opt(key);
        if (raw == null && fallback != null) return fallback;
        if (!(raw instanceof Number)) throw new IllegalArgumentException();
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value < min || value > max) throw new IllegalArgumentException();
        return value;
    }

    private void lifecycle(Action action) {
        if (Looper.myLooper() == Looper.getMainLooper()) action.run();
        else main.post(action::run);
    }

    @Override protected void handleOnPause() {
        lifecycle(() -> { background = true; if (session != null) session.setBackground(true); });
        super.handleOnPause();
    }
    @Override protected void handleOnResume() {
        lifecycle(() -> { background = false; if (session != null) session.setBackground(false); });
        super.handleOnResume();
    }
    @Override protected void handleOnDestroy() {
        synchronized (calls) { destroyed = true; }
        lifecycle(() -> {
            try {
                if (session != null) {
                    PrismPlayerSession previous = session; session = null;
                    previous.close();
                }
            } finally {
                PluginCall[] pending;
                synchronized (calls) { pending = calls.toArray(new PluginCall[0]); }
                for (PluginCall call : pending) settle(call, "PLUGIN_DESTROYED");
                usedSessions.clear();
            }
        });
        super.handleOnDestroy();
    }
}
