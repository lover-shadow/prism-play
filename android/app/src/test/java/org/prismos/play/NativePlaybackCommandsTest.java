package org.prismos.play;

import org.junit.Test;
import static org.junit.Assert.*;

public final class NativePlaybackCommandsTest {
    @Test public void oldObserverCannotRemoveNewMediaSession() {
        long[] observed = new long[1];
        NativePlaybackCommands.StateListener old = (playing, position, rate) -> observed[0] = -1;
        NativePlaybackCommands.StateListener current = (playing, position, rate) -> observed[0] = position;
        NativePlaybackCommands.observe(old);
        NativePlaybackCommands.observe(current);
        NativePlaybackCommands.removeObserver(old);
        NativePlaybackCommands.report(true, 1234, 1);
        assertEquals(1234, observed[0]);
        NativePlaybackCommands.removeObserver(current);
        NativePlaybackCommands.report(false, 99, 1);
        assertEquals(1234, observed[0]);
    }
    @Test public void routesOnlyConsumedCommandsAndPreservesNewSession() {
        NativePlaybackCommands.Listener old = command -> command.equals("toggle");
        NativePlaybackCommands.Listener current = command -> command.equals("pause");
        NativePlaybackCommands.install(old);
        assertTrue(NativePlaybackCommands.dispatch("toggle"));
        assertFalse(NativePlaybackCommands.dispatch("next"));
        NativePlaybackCommands.install(current);
        NativePlaybackCommands.remove(old);
        assertTrue(NativePlaybackCommands.dispatch("pause"));
        assertFalse(NativePlaybackCommands.dispatch("toggle"));
        NativePlaybackCommands.remove(current);
        assertFalse(NativePlaybackCommands.dispatch("pause"));
    }
}
