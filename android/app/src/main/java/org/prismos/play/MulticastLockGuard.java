package org.prismos.play;

import android.content.Context;
import android.net.wifi.WifiManager;
import androidx.annotation.Nullable;
import com.getcapacitor.Logger;

/**
 * H2 (SPEC §1.5.2.1) — the Wi-Fi multicast lock that SSDP discovery depends on.
 *
 * Without {@code CHANGE_WIFI_MULTICAST_STATE} plus a held {@code WifiManager.MulticastLock} the chipset
 * keeps its IGMP snooping filtered and the device replies (multicast, or unicast the stack also drops
 * under power save) never reach the socket. The observed symptom of forgetting this is "扫描零设备" on an
 * otherwise healthy home Wi-Fi, which is indistinguishable from "no TV on the network" — the worst kind of
 * failure to debug, so the lock is wrapped here and cannot be acquired without a matching release.
 *
 * WHY THE LOCK MUST NOT BE HELD: it forces the Wi-Fi radio to stay fully awake instead of paging, which is
 * a measurable battery drain (Android's own docs call a leaked multicast lock a power regression, and OEM
 * battery-hog reports name it). Discovery is a ~3s window, so the lock is worth exactly 3 seconds.
 * Keeping it for the life of the player would silently tax the user for a feature they stopped using, and
 * Android 12+ thermal/battery heuristics start throttling always-on multicast apps.
 *
 * The pairing is enforced by the type, not by discipline: {@link #acquire()} hands back an
 * {@link Session} that is {@link AutoCloseable}, so the scan runs inside try-with-resources and every exit
 * path — normal return, early break, thrown exception, interrupt — releases the lock. {@code close()} is
 * idempotent and reference counting is switched OFF, so one release definitively frees the lock instead of
 * needing a matching count. {@link #forceRelease()} is the second net for process teardown: a scan thread
 * killed while blocked in {@code receive()} may never reach its own {@code close()}.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Review-only.
 */
final class MulticastLockGuard {

    /** Appears in dumpsys wifi and in battery-hog reports; keep it identifiable to this feature. */
    private static final String LOCK_TAG = "prism.cast.ssdp";

    @Nullable
    private final WifiManager wifi;
    @Nullable
    private Session active;

    MulticastLockGuard(Context context) {
        WifiManager manager = null;
        try {
            Object service = context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (service instanceof WifiManager) {
                manager = (WifiManager) service;
            }
        } catch (RuntimeException ex) {
            // Wi-Fi tablets report no WIFI_SERVICE at all on a few ROMs; discovery degrades, nothing crashes.
            Logger.warn("PrismCastLock", "wifi service unavailable: " + ex.getMessage());
        }
        wifi = manager;
    }

    /** False on devices with no Wi-Fi stack — the TS side must then say "本机不支持组播扫描". */
    boolean isAvailable() {
        return wifi != null;
    }

    boolean isHeld() {
        Session current = active;
        return current != null && current.held();
    }

    /**
     * Acquires for one scan window. Callers MUST close the returned session (use try-with-resources);
     * acquiring over a live session releases the previous one first, so a re-scan can never stack locks.
     */
    Session acquire() {
        forceRelease();
        WifiManager.MulticastLock lock = null;
        if (wifi != null) {
            try {
                lock = wifi.createMulticastLock(LOCK_TAG);
                // Non-reference-counted: a single release() is definitive, which removes the "who else
                // acquired it" class of bug at the cost of co-tenancy — nothing else in this app multicasts.
                lock.setReferenceCounted(false);
                lock.acquire();
            } catch (RuntimeException ex) {
                lock = null;
                Logger.warn("PrismCastLock", "multicast lock refused: " + ex.getMessage());
            }
        }
        active = new Session(lock);
        return active;
    }

    /** Process-teardown net, called from the plugin's destroy path and from every re-scan. */
    void forceRelease() {
        Session current = active;
        if (current != null) {
            current.close();
        }
        active = null;
    }

    /** The RAII handle returned by {@link #acquire()}; closing it is what ends the scan window's hold. */
    final class Session implements AutoCloseable {

        @Nullable
        private WifiManager.MulticastLock lock;

        Session(@Nullable WifiManager.MulticastLock lock) {
            this.lock = lock;
        }

        /** True when the radio really is unlocked for multicast; false answers are reported to JS. */
        boolean held() {
            WifiManager.MulticastLock current = lock;
            return current != null && current.isHeld();
        }

        @Override
        public void close() {
            WifiManager.MulticastLock current = lock;
            if (current == null) {
                return;
            }
            lock = null;
            try {
                current.release();
            } catch (RuntimeException ex) {
                // Already released by the framework, or the ROM threw. Either way the hold is over.
                Logger.warn("PrismCastLock", "release refused: " + ex.getMessage());
            }
            if (active == this) {
                active = null;
            }
        }
    }
}
