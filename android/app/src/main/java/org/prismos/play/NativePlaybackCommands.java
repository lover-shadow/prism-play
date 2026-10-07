package org.prismos.play;

final class NativePlaybackCommands {
    static final String PLAY = "native-play";
    static final String PAUSE = "native-pause";
    interface Listener { boolean onCommand(String command); }
    interface StateListener { void onState(boolean playing, long position, float rate); }
    private static volatile StateListener stateListener;
    static void observe(StateListener value) { stateListener = value; }
    static void removeObserver(StateListener value) { if (stateListener == value) stateListener = null; }
    static void report(boolean playing, long position, float rate) {
        StateListener current = stateListener;
        if (current != null) current.onState(playing, position, rate);
    }
    private static volatile Listener listener;
    private NativePlaybackCommands() {}
    static void install(Listener value) { listener = value; }
    static void remove(Listener value) { if (listener == value) listener = null; }
    static boolean dispatch(String command) {
        Listener current = listener;
        return current != null && current.onCommand(command);
    }
}
