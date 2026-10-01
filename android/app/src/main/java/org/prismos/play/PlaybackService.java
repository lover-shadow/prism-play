package org.prismos.play;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import com.getcapacitor.Logger;

/**
 * AC-10 / F-05: the mediaPlayback foreground service that keeps audio alive when the screen turns
 * off or the user leaves the app, with a MediaStyle card carrying 剧名 + 集数 and transport buttons.
 *
 * The audio itself is still produced by the WebView's media element in this same process: nothing here
 * plays a stream. What the service buys is (a) process priority and a visible reason to exist, (b) an
 * audio-focus claim so the system stops suspending background media, (c) a bounded partial wake lock so
 * the CPU does not sleep mid-episode. Capacitor keeps the WebView timers running while paused
 * (BridgeActivity.keepRunning / Bridge.shouldKeepRunning default to true), which is why JS-driven HLS
 * playback survives at all - a fact that has to be observed on a real phone, not assumed (checklist 4).
 *
 * TWO HONEST LIMITATIONS, BOTH BY DESIGN RATHER THAN OMISSION:
 * 1. No MediaSession token is attached (androidx.media is not in the dependency set on purpose), so the
 *    card lives in the notification shade and not in the system media panel / lock-screen controls or
 *    on Bluetooth headsets. AC-10 only requires the shade card; promoting it is a Stage 4 decision.
 * 2. The play/pause glyph reflects the state this service last saw (a startBackgroundAudio call, or the
 *    button being pressed), not the truth inside the <video> element. Reading that truth would mean
 *    polling JS from a timer - the exact anti-pattern ARCHITECTURE 1.1 condemns - so the icon is allowed
 *    to lag and the button always forwards a TOGGLE to the authoritative side.
 * 3. PowerManager.PARTIAL_WAKE_LOCK is deprecated since API 28 yet still honoured, and it remains the
 *    only way to keep the CPU awake for screen-off audio without a media session; hence the timeout.
 *
 * Notification commands reach JavaScript through PrismNativePlugin's installed CommandListener, which
 * evaluates a documented window.PrismNativeMedia hook. The command vocabulary handed to that hook is
 * ACTION_TOGGLE / ACTION_NEXT / ACTION_PREVIOUS / ACTION_STOP (the reversed-DNS action strings) plus
 * COMMAND_FOCUS_LOST / COMMAND_FOCUS_REGAINED. Without the hook the buttons are inert; the hook name is
 * part of the Stage 3 integration contract.
 */
public final class PlaybackService extends Service {

    static final String ACTION_START = "org.prismos.play.action.START_PLAYBACK";
    static final String ACTION_STOP = "org.prismos.play.action.STOP_PLAYBACK";
    static final String ACTION_TOGGLE = "org.prismos.play.action.TOGGLE";
    static final String ACTION_NEXT = "org.prismos.play.action.NEXT";
    static final String ACTION_PREVIOUS = "org.prismos.play.action.PREVIOUS";
    /** Focus-only commands for the JavaScript hook; they are never Intent actions. */
    static final String COMMAND_FOCUS_LOST = "focus-lost";
    static final String COMMAND_FOCUS_REGAINED = "focus-regained";
    static final String EXTRA_TITLE = "extra_title";
    static final String EXTRA_EPISODE = "extra_episode";

    private static final String CHANNEL_ID = "prism_playback";
    private static final int NOTIFICATION_ID = 20260;
    /** Hard ceiling on the wake lock so a leaked service cannot drain a battery overnight. */
    private static final long WAKE_LOCK_LIMIT_MS = 4L * 60L * 60L * 1000L;

    /** Bridge to the WebView: receives ACTION_TOGGLE / ACTION_NEXT / ACTION_PREVIOUS. */
    public interface CommandListener {
        void onCommand(String action);
    }

    private static CommandListener commandListener;

    static void setCommandListener(CommandListener listener) {
        commandListener = listener;
    }

    private AudioManager audioManager;
    @androidx.annotation.Nullable
    private AudioFocusRequest focusRequest;
    /** One stable listener instance: request and abandon must hand AudioManager the same object. */
    private final AudioManager.OnAudioFocusChangeListener focusListener = this::onFocusChange;
    private PowerManager.WakeLock wakeLock;
    private String title = "";
    private String episode = "";
    private boolean showingPauseGlyph = true;
    private boolean focusHeld = false;

    static void start(Context context, String titleLabel, String episodeLabel) {
        Intent intent = new Intent(context, PlaybackService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TITLE, titleLabel)
                .putExtra(EXTRA_EPISODE, episodeLabel);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        context.startService(new Intent(context, PlaybackService.class).setAction(ACTION_STOP));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        audioManager = (AudioManager) getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        createChannel();
        PowerManager powerManager =
                (PowerManager) getApplicationContext().getSystemService(Context.POWER_SERVICE);
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "prism:playback");
        wakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null || intent.getAction() == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(action) || ACTION_NEXT.equals(action) || ACTION_PREVIOUS.equals(action)) {
            if (ACTION_TOGGLE.equals(action)) {
                showingPauseGlyph = !showingPauseGlyph;
            }
            dispatch(action);
            postNotification();
            return START_STICKY;
        }
        // START_STICKY restarts this service with a null intent: keep the last labels we were given
        // instead of overwriting them with the generic fallback, and only fall back on first start.
        String incomingTitle = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
        String incomingEpisode = intent == null ? null : intent.getStringExtra(EXTRA_EPISODE);
        if (incomingTitle != null) {
            title = safeLabel(incomingTitle, getString(R.string.prism_playback_default_title));
        }
        if (incomingEpisode != null) {
            episode = safeLabel(incomingEpisode, getString(R.string.prism_playback_default_episode));
        }
        if (title.isEmpty()) { title = getString(R.string.prism_playback_default_title); }
        if (episode.isEmpty()) { episode = getString(R.string.prism_playback_default_episode); }
        showingPauseGlyph = true;
        requestAudioFocus();
        acquireWakeLock();
        // API 34 rejects startForeground without the type the manifest declares; on 29+ ServiceCompat
        // passes it, and below 29 the two-arg call is the only form that exists.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification().build(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification().build());
        }
        postNotification();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        abandonAudioFocus();
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }

    @Override
    public android.os.IBinder onBind(Intent intent) {
        // Started-only service: binding would invite a lifecycle we cannot keep honest about.
        return null;
    }

    private void dispatch(String action) {
        CommandListener listener = commandListener;
        if (listener == null) {
            Logger.warn("PrismPlayback", "no command listener installed; notification button ignored");
            return;
        }
        listener.onCommand(action);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, getString(R.string.prism_playback_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.prism_playback_channel_description));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        NotificationManagerCompat.from(this).createNotificationChannel(channel);
    }

    private NotificationCompat.Builder buildNotification() {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_prism)
                .setContentTitle(title)
                .setContentText(episode)
                .setSubText(getString(R.string.prism_playback_ongoing_hint))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .addAction(R.drawable.ic_media_previous,
                        getString(R.string.prism_playback_action_previous), broadcast(ACTION_PREVIOUS, 11))
                .addAction(showingPauseGlyph ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                        getString(showingPauseGlyph ? R.string.prism_playback_action_pause : R.string.prism_playback_action_play),
                        broadcast(ACTION_TOGGLE, 12))
                .addAction(R.drawable.ic_media_next,
                        getString(R.string.prism_playback_action_next), broadcast(ACTION_NEXT, 13))
                .setStyle(new MediaStyle().setShowActionsInCompactView(0, 1, 2));
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        builder.setContentIntent(PendingIntent.getActivity(this, 14, open, immutableFlags()));
        return builder;
    }

    private PendingIntent broadcast(String action, int requestCode) {
        return PendingIntent.getBroadcast(this, requestCode,
                new Intent(this, PlaybackService.class).setAction(action), immutableFlags());
    }

    /** FLAG_IMMUTABLE is mandatory from API 31 and available from 23, which is our minSdk. */
    private static int immutableFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private static String safeLabel(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private void postNotification() {
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification().build());
        } catch (SecurityException ex) {
            // POST_NOTIFICATIONS denied: the service and its focus claim still work, only the card hides.
            Logger.warn("PrismPlayback", "notification suppressed: " + ex.getMessage());
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(WAKE_LOCK_LIMIT_MS);
        }
    }

    private void requestAudioFocus() {
        if (audioManager == null || focusHeld) {
            return;
        }
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                            .build())
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
            focusRequest = request;
            result = audioManager.requestAudioFocus(request);
        } else {
            result = audioManager.requestAudioFocus(
                    focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        focusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        if (!focusHeld) {
            Logger.warn("PrismPlayback", "audio focus refused; screen-off playback is at risk");
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null || !focusHeld) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
        focusHeld = false;
    }

    private void onFocusChange(int focusChange) {
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
            // Permanent loss (another app took media focus): release the foreground claim so the OS is
            // free to stop us; the wake lock and focus go with it in onDestroy.
            dispatch(ACTION_STOP);
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        // Transient loss / duck and regaining: forwarded as focus commands so TypeScript - which owns
        // the media element - decides to pause, duck the player volume, or resume.
        dispatch(focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                ? COMMAND_FOCUS_LOST
                : COMMAND_FOCUS_REGAINED);
    }
}
