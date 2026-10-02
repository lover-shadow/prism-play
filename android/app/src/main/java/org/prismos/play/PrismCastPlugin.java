package org.prismos.play;

import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The Android half of the DLNA cast bridge declared in src/core/native/cast.ts. Plugin id, method names and
 * the option/payload keys below are the frozen integration surface — a mismatch is only visible on a phone,
 * so the wire shape is pinned here and mirrored on the TypeScript side, and {@code verify_android_assets.py}
 * compares the two plugin-name literals verbatim (gate rule 6).
 *
 * Responsibilities are split, not stacked here: {@link SsdpDiscovery} owns the probe and the description
 * document, {@link SoapEnvelope} owns every byte of SOAP/DIDL markup, {@link SoapController} owns the raw
 * HTTP/1.1 transport that H1 requires, {@link LanAddressPolicy} owns which destinations are allowed at all,
 * {@link MulticastLockGuard} owns H2. This class owns only the call surface, the thread hand-off and the
 * registry of devices this device actually discovered.
 *
 * THE REGISTRY IS THE POINT. {@code castMedia} and {@code controlMedia} accept a {@code deviceId} and look
 * the control URL up here; there is no method that takes a host or a URL from JavaScript. A page — ours, a
 * malicious catalogue payload's, or a buggy one — therefore cannot aim the phone's cleartext socket at an
 * arbitrary address, which is the third safety condition behind the H1 sign-off. Entries are replaced by the
 * next scan and dropped on destroy.
 *
 * Capacitor dispatches plugin methods on {@code Bridge.taskHandler}, so a 3.2 s scan there would serialise
 * unrelated bridge calls behind it; every blocking operation is handed to this plugin's own executor, which
 * is shut down in {@link #handleOnDestroy()} along with the multicast lock.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Real-device evidence for
 * AC-24 comes from the phone, not from this box.
 */
@CapacitorPlugin(name = PrismCastPlugin.PLUGIN_ID)
public final class PrismCastPlugin extends Plugin {

    /** Must equal {@code PRISM_CAST_PLUGIN} in src/core/native/cast.ts, character for character. */
    static final String PLUGIN_ID = "PrismCast";

    private static final int MAX_REMEMBERED_DEVICES = 24;

    private final Map<String, SsdpDiscovery.Device> discovered = new ConcurrentHashMap<>();
    @Nullable
    private MulticastLockGuard locks;
    @Nullable
    private SsdpDiscovery discovery;
    @Nullable
    private ExecutorService io;
    private volatile boolean scanning;

    @Override
    public void load() {
        locks = new MulticastLockGuard(getContext());
        discovery = new SsdpDiscovery(locks);
        io = Executors.newSingleThreadExecutor(castThreadFactory());
    }

    /**
     * Resolves with the whole device list once the window closes. Progressive per-device events were
     * deliberately not chosen: they need addListener/removeListener overrides (see PrismNativePlugin's
     * annotation caveat), and a 3.2 s sheet that fills in 1.5 s early is not worth a second lifecycle to
     * get wrong on a feature that cannot be tested from this machine.
     */
    @PluginMethod
    public void startDiscovery(PluginCall call) {
        SsdpDiscovery engine = discovery;
        ExecutorService worker = io;
        if (engine == null || worker == null) {
            call.reject("投屏模块未就绪", "CAST_UNAVAILABLE");
            return;
        }
        if (scanning) {
            // Honest busy answer instead of two overlapping scans fighting over one multicast lock.
            call.reject("扫描正在进行，请稍候", "DISCOVERY_BUSY");
            return;
        }
        scanning = true;
        discovered.clear();
        worker.execute(() -> {
            try {
                SsdpDiscovery.Result result = engine.scan();
                remember(result.devices);
                call.resolve(discoveryPayload(result));
            } catch (RuntimeException ex) {
                call.reject("设备扫描失败：" + safe(ex.getMessage()), "DISCOVERY_FAILED", ex);
            } finally {
                scanning = false;
            }
        });
    }

    /** Ends the current window early. Idempotent, and always releases the lock — H2's release path. */
    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        SsdpDiscovery engine = discovery;
        MulticastLockGuard guard = locks;
        if (engine != null) {
            engine.stop();
        }
        if (guard != null) {
            guard.forceRelease();
        }
        scanning = false;
        JSObject payload = new JSObject();
        payload.put("stopped", true);
        payload.put("multicastLockReleased", guard == null || !guard.isHeld());
        call.resolve(payload);
    }

    /** Options: {@code deviceId} (required), {@code streamUrl} (required, public https proxy handle), {@code title}, {@code mimeType}. */
    @PluginMethod
    public void castMedia(PluginCall call) {
        SsdpDiscovery.Device device = approvedDevice(call);
        ExecutorService worker = io;
        if (device == null || worker == null) {
            return;
        }
        String streamUrl = call.getString("streamUrl");
        if (streamUrl == null || streamUrl.trim().isEmpty()) {
            call.reject("缺少投屏地址", "ARGUMENT_REQUIRED");
            return;
        }
        String title = call.getString("title");
        String mimeType = call.getString("mimeType");
        String controlUrl = device.controlUrl;
        worker.execute(() -> {
            try {
                SoapController.castTo(controlUrl, streamUrl.trim(), title, mimeType);
                call.resolve(statePayload(device, "playing"));
            } catch (SoapController.ControlException ex) {
                call.reject(safe(ex.getMessage()), "CAST_FAILED", ex);
            }
        });
    }

    /** Options: {@code deviceId}, {@code action} — the closed set {@code play} / {@code pause} / {@code stop}. */
    @PluginMethod
    public void controlMedia(PluginCall call) {
        SsdpDiscovery.Device device = approvedDevice(call);
        ExecutorService worker = io;
        if (device == null || worker == null) {
            return;
        }
        String action;
        try {
            action = SoapEnvelope.actionOf(call.getString("action"));
        } catch (SoapController.ControlException ex) {
            call.reject(safe(ex.getMessage()), "ACTION_NOT_ALLOWED");
            return;
        }
        String controlUrl = device.controlUrl;
        worker.execute(() -> {
            try {
                SoapController.control(controlUrl, action);
                call.resolve(statePayload(device, "pause".equalsIgnoreCase(action) ? "paused"
                        : ("stop".equalsIgnoreCase(action) ? "stopped" : "playing")));
            } catch (SoapController.ControlException ex) {
                call.reject(safe(ex.getMessage()), "CONTROL_FAILED", ex);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        MulticastLockGuard guard = locks;
        if (guard != null) {
            // The lock must not outlive the WebView: a scan thread blocked in receive() may never reach its
            // own close(), and a held multicast lock is a battery regression the user cannot see.
            guard.forceRelease();
        }
        SsdpDiscovery engine = discovery;
        if (engine != null) {
            engine.stop();
        }
        ExecutorService worker = io;
        if (worker != null) {
            worker.shutdownNow();
        }
        discovered.clear();
        scanning = false;
        super.handleOnDestroy();
    }

    /** The only way JavaScript reaches a device: by id, resolved against what this phone itself discovered. */
    @Nullable
    private SsdpDiscovery.Device approvedDevice(PluginCall call) {
        String id = call.getString("deviceId");
        SsdpDiscovery.Device device = id == null ? null : discovered.get(id);
        if (device == null) {
            // DEVICE_NOT_DISCOVERED is the answer to a stale row, a forged id and an off-LAN control URL
            // alike, and it is the reason no call in this plugin accepts a host from the WebView.
            call.reject("该设备不在本机发现结果内，请重新扫描", "DEVICE_NOT_DISCOVERED");
            return null;
        }
        return device;
    }

    private void remember(List<SsdpDiscovery.Device> devices) {
        discovered.clear();
        for (SsdpDiscovery.Device device : devices) {
            if (discovered.size() >= MAX_REMEMBERED_DEVICES) {
                break;
            }
            discovered.put(device.id, device);
        }
    }

    private JSObject discoveryPayload(SsdpDiscovery.Result result) {
        JSArray devices = new JSArray();
        for (SsdpDiscovery.Device device : result.devices) {
            devices.put(device.toJson());
        }
        JSObject payload = new JSObject();
        payload.put("devices", devices);
        payload.put("count", result.devices.size());
        payload.put("probesSent", result.probesSent);
        payload.put("multicastAvailable", result.multicastAvailable);
        payload.put("multicastLockReleased", result.lockReleased);
        return payload;
    }

    private static JSObject statePayload(SsdpDiscovery.Device device, String state) {
        JSObject payload = new JSObject();
        payload.put("deviceId", device.id);
        payload.put("deviceName", device.name);
        payload.put("state", state);
        return payload;
    }

    private static String safe(@Nullable String message) {
        return message == null || message.trim().isEmpty() ? "未知错误" : message.trim();
    }

    /** Daemon threads: a hung TV socket must never be the reason a process cannot exit. */
    private static ThreadFactory castThreadFactory() {
        AtomicInteger counter = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task, "prism-cast-" + counter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
