package org.prismos.play;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import java.util.function.Consumer;

final class PlaybackMediaSession implements AutoCloseable {
    private final MediaSessionCompat session;
    PlaybackMediaSession(Context context, Consumer<String> commands) {
        session = new MediaSessionCompat(context, "PrismPlayback");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { commands.accept(NativePlaybackCommands.PLAY); }
            @Override public void onPause() { commands.accept(NativePlaybackCommands.PAUSE); }
            @Override public void onStop() { commands.accept(PlaybackService.ACTION_STOP); }
            @Override public void onSkipToNext() { commands.accept(PlaybackService.ACTION_NEXT); }
            @Override public void onSkipToPrevious() { commands.accept(PlaybackService.ACTION_PREVIOUS); }
        }, new Handler(Looper.getMainLooper()));
        session.setActive(true);
    }
    MediaSessionCompat.Token token() { return session.getSessionToken(); }
    void metadata(String title, String episode) {
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, episode).build());
    }
    void state(boolean playing, long position, float rate) {
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_STOP | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                position, playing ? rate : 0).build());
    }
    @Override public void close() { session.setActive(false); session.release(); }
}
