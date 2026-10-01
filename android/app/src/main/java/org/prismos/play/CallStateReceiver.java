package org.prismos.play;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.telephony.TelephonyManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Logger;

/**
 * AC-11 sensor: maps the telephony state broadcast onto the three values of CallState in
 * src/core/native/bridge.ts ('idle' | 'ringing' | 'offhook') and forwards them to the plugin, which
 * republishes them as the "callState" event.
 *
 * Registration is DYNAMIC and NOT_EXPORTED, and the manifest keeps this receiver exported=false with
 * no intent-filter. A statically registered PHONE_STATE receiver would have to be exported, i.e. any
 * other app on the phone could fire a fake RINGING and pause the user's video. Dynamic registration
 * also ties the listener lifetime to the JavaScript subscription: no subscriber, no receiver.
 *
 * WHAT THIS CLASS DELIBERATELY DOES NOT KNOW (integration contract for the TypeScript side):
 * the AC-11 resume preconditions - "was playing when the call arrived", "the user paused or switched
 * away during the call", "audio focus came back" - are player/UI state that only the WebView owns.
 * There is no bridge method or event to carry them, so they MUST live in TypeScript. The native layer
 * only reports the raw state transitions, and TS decides whether to resume or stay paused.
 *
 * READ_PHONE_STATE is a runtime permission. When it is denied the broadcast is simply never delivered
 * (some OEM ROMs throw at registration, caught below), so AC-11 degrades to "no auto-pause" while
 * playback itself keeps working. Grep the settings copy: it must promise pause, not pause-and-resume,
 * wherever this is unverified.
 */
final class CallStateReceiver extends BroadcastReceiver {

    /** Protected system broadcast; the API 30 constant name is the same string, inlined at compile time. */
    private static final String PHONE_STATE_ACTION = "android.intent.action.PHONE_STATE";

    static final String STATE_IDLE = "idle";
    static final String STATE_RINGING = "ringing";
    static final String STATE_OFFHOOK = "offhook";

    /** Sink the plugin installs; called on the main thread by the broadcast dispatch itself. */
    interface Sink {
        void onCallState(String state);
    }

    private final Sink sink;
    private boolean registered = false;

    CallStateReceiver(Sink sink) {
        this.sink = sink;
    }

    void register(Context context) {
        if (registered) {
            return;
        }
        try {
            ContextCompat.registerReceiver(
                    context.getApplicationContext(),
                    this,
                    new IntentFilter(PHONE_STATE_ACTION),
                    ContextCompat.RECEIVER_NOT_EXPORTED);
            registered = true;
        } catch (SecurityException | IllegalArgumentException ex) {
            // Missing READ_PHONE_STATE or a telephony-less ROM: degrade AC-11, never crash the host.
            Logger.warn("PrismCallState", "cannot register call-state receiver: " + ex.getMessage());
            registered = false;
        }
    }

    void unregister(Context context) {
        if (!registered) {
            return;
        }
        try {
            context.getApplicationContext().unregisterReceiver(this);
        } catch (IllegalArgumentException ignored) {
            // Already gone (process teardown race); nothing to report to the user.
        }
        registered = false;
    }

    boolean isRegistered() {
        return registered;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !PHONE_STATE_ACTION.equals(intent.getAction())) {
            return;
        }
        String raw = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        String mapped = mapState(raw);
        if (mapped == null) {
            return;
        }
        // TelephonyManager.EXTRA_INCOMING_NUMBER is intentionally never read: a phone number is
        // personal data this app has no use for, and AC-02 keeps caller identity out of every log.
        sink.onCallState(mapped);
    }

    /** Unknown or future states return null instead of guessing, so TS never sees a fabricated idle. */
    static String mapState(@androidx.annotation.Nullable String telephonyState) {
        if (TelephonyManager.EXTRA_STATE_RINGING.equals(telephonyState)) {
            return STATE_RINGING;
        }
        if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(telephonyState)) {
            return STATE_OFFHOOK;
        }
        if (TelephonyManager.EXTRA_STATE_IDLE.equals(telephonyState)) {
            return STATE_IDLE;
        }
        return null;
    }
}
