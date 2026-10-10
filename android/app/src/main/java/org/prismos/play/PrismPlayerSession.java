package org.prismos.play;

import android.content.Context;
import android.os.Handler;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import com.getcapacitor.JSObject;
import java.net.SocketTimeoutException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

@UnstableApi
final class PrismPlayerSession implements AutoCloseable {
    enum Event {
        ended, timeupdate, play, playing, pause, waiting, seeking, seeked, error, loadedmetadata, firstframe
    }
    final String id;
    final PrismPlayerSurface surface;
    private final Context context;
    private final Handler main;
    private final Consumer<JSObject> events;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Object deliveryLock = new Object();
    private ProbeNativeResolver resolver;
    private ProbeNativeResolver.Result result, pending;
    private ProbeCencDataSource.Factory factory;
    private ExoPlayer player;
    private long generation;
    private boolean closed, background, metadata, seeking;
    private float volume = 1, rate = 1;
    private boolean resumeAfterFocus, backgroundAllowed;
    private boolean canPlayBackground() { return backgroundAllowed && PlaybackService.isRunning(); }
    void setBackgroundAllowed(boolean allowed) {
        backgroundAllowed = allowed;
        if (background && !allowed && player != null) { resumeAfterFocus = false; player.pause(); }
        main.removeCallbacks(ticker);
        if (!closed && (!background || canPlayBackground())) main.postDelayed(ticker, 250);
    }
    private final NativePlaybackCommands.Listener commands = this::notificationCommand;
    private BiConsumer<Boolean, String> completion;
    private Runnable deadline;
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (closed) return;
            if (background && !canPlayBackground()) { if (player != null) player.pause(); return; }
            if (player != null) emit(Event.timeupdate, null);
            main.postDelayed(this, 250);
        }
    };

    PrismPlayerSession(String id, Context context, Handler main, PrismPlayerSurface surface,
            Consumer<JSObject> events, boolean background) {
        this.id = id; this.context = context; this.main = main;
        this.surface = surface; this.events = events; this.background = background;
        NativePlaybackCommands.install(commands);
        if (!background || canPlayBackground()) main.postDelayed(ticker, 250);
    }

    void setSource(String videoId, double position, BiConsumer<Boolean, String> callback) {
        invalidate("SOURCE_REPLACED");
        completion = callback;
        final long token = generation;
        final ProbeNativeResolver request = new ProbeNativeResolver();
        synchronized (deliveryLock) { resolver = request; }
        deadline = () -> {
            if (!current(token)) return;
            emit(Event.error, null);
            invalidate("RESOLVE_TIMEOUT");
        };
        main.postDelayed(deadline, 60000);
        try {
            executor.execute(() -> {
                ProbeNativeResolver.Result resolved = null;
                try { resolved = request.resolve(videoId); }
                catch (Exception ignored) { }
                synchronized (deliveryLock) {
                    if (!current(token)) {
                        request.close();
                        if (resolved != null) resolved.close();
                        return;
                    }
                    pending = resolved;
                    if (!main.post(() -> deliver(token, position))) {
                        request.close();
                        if (pending != null) pending.close();
                        pending = null;
                    }
                }
            });
        } catch (RuntimeException error) { invalidate("SOURCE_UNAVAILABLE"); }
    }

    private boolean current(long token) {
        synchronized (deliveryLock) { return !closed && token == generation; }
    }

    private void deliver(long token, double position) {
        if (!current(token)) return;
        main.removeCallbacks(deadline);
        synchronized (deliveryLock) { result = pending; pending = null; }
        if (result == null) {
            emit(Event.error, null);
            invalidate("RESOLVE_FAILED");
            return;
        }
        try {
            factory = new ProbeCencDataSource.Factory(result.url, result.key);
            player = new ExoPlayer.Builder(context).setMediaSourceFactory(
                new DefaultMediaSourceFactory(context).setDataSourceFactory(factory)).build();
            ExoPlayer sourcePlayer = player;
            player.setVolume(volume);
            player.setPlaybackSpeed(rate);
            player.setVideoTextureView(surface.texture);
            player.addListener(new Player.Listener() {
                private boolean live() { return current(token) && player == sourcePlayer; }
                @Override public void onPlaybackStateChanged(int state) {
                    if (!live()) return;
                    if (state == Player.STATE_READY) {
                        if (!metadata) { metadata = true; emit(Event.loadedmetadata, null); }
                        if (seeking) { seeking = false; emit(Event.seeked, null); }
                    } else if (state == Player.STATE_BUFFERING) emit(Event.waiting, null);
                    else if (state == Player.STATE_ENDED) emit(Event.ended, null);
                }
                @Override public void onIsPlayingChanged(boolean playing) {
                    if (live() && playing) emit(Event.playing, null);
                }
                @Override public void onPlayWhenReadyChanged(boolean ready, int reason) {
                    if (live() && sourcePlayer.getPlaybackState() != Player.STATE_ENDED
                            && sourcePlayer.getPlayerError() == null) emit(ready ? Event.play : Event.pause, null);
                }
                @Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition,
                        Player.PositionInfo newPosition, int reason) {
                    if (live() && reason == Player.DISCONTINUITY_REASON_SEEK
                            && sourcePlayer.getPlaybackState() == Player.STATE_READY && seeking) {
                        seeking = false; emit(Event.seeked, null);
                    }
                }
                @Override public void onPlayerError(PlaybackException error) {
                    if (!live()) return;
                    emit(Event.error, classify(error));
                    invalidate("PLAYBACK_FAILED");
                }
                @Override public void onVideoSizeChanged(VideoSize size) {
                    if (live() && metadata) emit(Event.loadedmetadata, null);
                }
                @Override public void onRenderedFirstFrame() {
                    if (live()) emit(Event.firstframe, null);
                }
            });
            player.setMediaItem(new MediaItem.Builder().setUri(result.url)
                .setMimeType("video/mp4").build(), Math.round(position * 1000));
            player.prepare();
            finish(true, null);
        } catch (RuntimeException error) {
            emit(Event.error, null);
            invalidate("PREPARE_FAILED");
        }
    }

    void play() {
        requirePlayer();
        if (background && !canPlayBackground()) throw new IllegalStateException();
        resumeAfterFocus = false;
        main.removeCallbacks(ticker);
        main.postDelayed(ticker, 250);
        player.play();
    }
    void pause() { requirePlayer(); resumeAfterFocus = false; player.pause(); }
    void seek(double seconds) {
        requirePlayer();
        seeking = true;
        emit(Event.seeking, null);
        player.seekTo(Math.round(seconds * 1000));
        if (player.getPlaybackState() == Player.STATE_READY && seeking) {
            seeking = false; emit(Event.seeked, null);
        }
    }
    void setVolume(float value) { volume = value; if (player != null) player.setVolume(value); }
    void setRate(float value) { rate = value; if (player != null) player.setPlaybackSpeed(value); }
    private void requirePlayer() { if (player == null) throw new IllegalStateException(); }

    void setBackground(boolean value) {
        background = value;
        main.removeCallbacks(ticker);
        if (value) { if (player != null && !canPlayBackground()) player.pause(); }
        if (!closed && (!value || canPlayBackground())) main.postDelayed(ticker, 250);
    }

    private boolean notificationCommand(String command) {
        if (closed || player == null) return false;
        if (PlaybackService.ACTION_NEXT.equals(command) || PlaybackService.ACTION_PREVIOUS.equals(command)) return false;
        boolean known = NativePlaybackCommands.PLAY.equals(command) || NativePlaybackCommands.PAUSE.equals(command)
            || PlaybackService.ACTION_TOGGLE.equals(command) || PlaybackService.ACTION_STOP.equals(command)
            || PlaybackService.COMMAND_FOCUS_LOST.equals(command) || PlaybackService.COMMAND_FOCUS_REGAINED.equals(command);
        if (!known) return false;
        final long commandGeneration = generation;
        main.post(() -> {
            if (!current(commandGeneration) || player == null) return;
            if (NativePlaybackCommands.PLAY.equals(command)) {
                resumeAfterFocus = false;
                if (!background || canPlayBackground()) player.play();
            } else if (NativePlaybackCommands.PAUSE.equals(command)) {
                resumeAfterFocus = false; player.pause();
            } else if (PlaybackService.ACTION_TOGGLE.equals(command)) {
                resumeAfterFocus = false;
                if (player.getPlayWhenReady()) player.pause();
                else if (!background || canPlayBackground()) player.play();
            } else if (PlaybackService.COMMAND_FOCUS_LOST.equals(command)) {
                resumeAfterFocus = resumeAfterFocus || player.getPlayWhenReady(); player.pause();
            } else if (PlaybackService.COMMAND_FOCUS_REGAINED.equals(command)) {
                if (resumeAfterFocus) { resumeAfterFocus = false; if (!background || canPlayBackground()) player.play(); }
            } else { resumeAfterFocus = false; player.pause(); }
        });
        return true;
    }

    private void emit(Event event, String failure) {
        if (closed) return;
        long duration = player == null ? C.TIME_UNSET : player.getDuration();
        VideoSize size = player == null ? VideoSize.UNKNOWN : player.getVideoSize();
        JSObject state = new JSObject().put("sessionId", id).put("event", event.name())
            .put("positionSeconds", player == null ? 0d : Math.max(0, player.getCurrentPosition()) / 1000d)
            .put("durationSeconds", duration == C.TIME_UNSET ? (result == null ? 0d : result.duration)
                : Math.max(0, duration) / 1000d)
            .put("playing", player != null && player.isPlaying()).put("volume", (double) volume)
            .put("rate", (double) rate).put("width", size.width).put("height", size.height);
        if (failure != null) state.put("failureCode", failure);
        if (player != null) NativePlaybackCommands.report(player.isPlaying(), player.getCurrentPosition(), rate);
        events.accept(state);
    }

    private static String classify(PlaybackException error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SocketTimeoutException) return "timeout";
        }
        int code = error.errorCode;
        if (code == PlaybackException.ERROR_CODE_TIMEOUT
                || code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) return "timeout";
        if (code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) return "http_error";
        if (code == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES) return "decode_error";
        return null;
    }

    private void finish(boolean ok, String code) {
        BiConsumer<Boolean, String> callback = completion;
        completion = null;
        if (callback != null) callback.accept(ok, code);
    }

    private void invalidate(String reason) {
        synchronized (deliveryLock) { generation++; }
        if (deadline != null) main.removeCallbacks(deadline);
        try {
            if (player != null) {
                ExoPlayer previous = player; player = null;
                try { previous.clearVideoTextureView(surface.texture); }
                finally { previous.release(); }
            }
        } finally {
            try {
                if (factory != null) {
                    ProbeCencDataSource.Factory previous = factory; factory = null;
                    previous.destroy();
                }
            } finally {
                synchronized (deliveryLock) {
                    if (resolver != null) { resolver.close(); resolver = null; }
                    if (pending != null) { pending.close(); pending = null; }
                }
                if (result != null) { result.close(); result = null; }
                metadata = false; seeking = false; resumeAfterFocus = false;
                NativePlaybackCommands.report(false, 0, rate);
                finish(false, reason);
            }
        }
    }

    @Override public void close() {
        synchronized (deliveryLock) { closed = true; }
        NativePlaybackCommands.remove(commands);
        main.removeCallbacks(ticker);
        try { invalidate("SESSION_RELEASED"); }
        finally { executor.shutdownNow(); surface.close(); }
    }
}
