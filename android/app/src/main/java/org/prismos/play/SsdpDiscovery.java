package org.prismos.play;

import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * SSDP media-renderer discovery (SPEC §1.5.2 step 1 and 2, AC-24).
 *
 * A browser cannot send UDP multicast, so this is the half that has to be native. UDP is not covered by the
 * platform cleartext policy at all — H1 constrains the SOAP control plane only, not discovery (SPEC
 * §1.5.2.2). The scan is a bounded window: one M-SEARCH burst, listen until the deadline, then let go.
 * Nothing is retried or left running, because a long-lived socket plus a long-lived multicast lock is
 * exactly the battery regression {@link MulticastLockGuard} exists to prevent.
 *
 * Two choices decide between "扫描到三台设备" and "扫描零设备" on real home Wi-Fi: every eligible interface
 * gets BOTH the multicast group and its directed broadcast address (some set-top renderers only ever answer
 * the broadcast copy, some TVs only the multicast copy, so one of the two halves the list), and an interface
 * refusing multicast is logged and skipped rather than fatal.
 *
 * Parsing lives in {@link UpnpDescription} — the socket-free half a fixture test can pin. A device only
 * reaches the caller once its description has been read, an AVTransport control URL resolved from it, and
 * both the LOCATION host and the control-URL host satisfy {@link LanAddressPolicy}: listing a renderer we
 * cannot control would make the tap failure read as our bug.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Review-only.
 */
final class SsdpDiscovery {

    /** Listen window; must exceed {@link SsdpMessage#MX_SECONDS} or replies that honoured MX arrive too late. */
    static final int WINDOW_MS = 3_200;
    private static final int MAX_PROBE_INTERFACES = 4;
    private static final int MAX_DEVICES = 24;
    private static final int DATAGRAM_BYTES = 4_096;

    private final MulticastLockGuard locks;
    @Nullable
    private volatile MulticastSocket live;
    private volatile boolean cancelled;

    SsdpDiscovery(MulticastLockGuard locks) {
        this.locks = locks;
    }

    /** One discovered renderer, already reduced to what the sheet lists and the control plane needs. */
    static final class Device {
        final String id;
        final String name;
        final String ip;
        final int port;
        final String controlUrl;
        final String location;

        Device(String id, String name, String ip, int port, String controlUrl, String location) {
            this.id = id;
            this.name = name;
            this.ip = ip;
            this.port = port;
            this.controlUrl = controlUrl;
            this.location = location;
        }

        JSObject toJson() {
            JSObject json = new JSObject();
            json.put("id", id);
            json.put("name", name);
            json.put("ip", ip);
            json.put("port", port);
            json.put("controlUrl", controlUrl);
            json.put("location", location);
            return json;
        }
    }

    /** The scan outcome plus the three facts that make "零设备" diagnosable instead of mysterious. */
    static final class Result {
        final List<Device> devices;
        final int probesSent;
        final boolean multicastAvailable;
        final boolean lockReleased;

        Result(List<Device> devices, int probesSent, boolean multicastAvailable, boolean lockReleased) {
            this.devices = devices;
            this.probesSent = probesSent;
            this.multicastAvailable = multicastAvailable;
            this.lockReleased = lockReleased;
        }
    }

    /** Runs one bounded scan window. Blocks the calling thread for up to {@link #WINDOW_MS}. */
    Result scan() {
        cancelled = false;
        List<Device> found = new ArrayList<>();
        int probesSent;
        try (MulticastLockGuard.Session hold = locks.acquire()) {
            MulticastSocket socket = null;
            try {
                socket = new MulticastSocket(0);
                live = socket;
                socket.setTimeToLive(4);
                socket.setBroadcast(true);
                probesSent = probe(socket);
                if (probesSent > 0 && !cancelled) {
                    collect(socket, found);
                }
            } catch (IOException | RuntimeException ex) {
                probesSent = 0;
                Logger.warn("PrismCastSsdp", "组播扫描不可用：" + ex.getMessage());
            } finally {
                closeLive();
            }
            // Reported rather than assumed: AC-24 asks for proof the lock went back down after the scan.
            return new Result(found, probesSent, locks.isAvailable(), !hold.held());
        }
    }

    /** Asks {@link #scan()} to stop now, and unblocks the pending {@code receive()} by closing the socket. */
    void stop() {
        cancelled = true;
        closeLive();
    }

    private void closeLive() {
        MulticastSocket socket = live;
        live = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (RuntimeException ignored) {
                // Already closed by stop(); the window is over either way.
            }
        }
    }

    private int probe(MulticastSocket socket) {
        byte[] request = SsdpMessage.searchRequest().getBytes(StandardCharsets.US_ASCII);
        int sent = 0;
        for (NetworkInterface nic : candidateInterfaces()) {
            try {
                socket.setNetworkInterface(nic);
                InetAddress group = InetAddress.getByName(SsdpMessage.MULTICAST_GROUP);
                socket.joinGroup(new InetSocketAddress(group, SsdpMessage.MULTICAST_PORT), nic);
                sent += transmit(socket, request, group);
                for (InterfaceAddress address : nic.getInterfaceAddresses()) {
                    InetAddress broadcast = address.getBroadcast();
                    if (broadcast != null) {
                        sent += transmit(socket, request, broadcast);
                    }
                }
            } catch (IOException | RuntimeException ex) {
                Logger.warn("PrismCastSsdp", "接口 " + nic.getName() + " 探测失败：" + ex.getMessage());
            }
        }
        return sent;
    }

    private static int transmit(MulticastSocket socket, byte[] request, InetAddress target) {
        try {
            socket.send(new DatagramPacket(request, request.length, target, SsdpMessage.MULTICAST_PORT));
            return 1;
        } catch (IOException ex) {
            return 0;
        }
    }

    /**
     * Only a real, up, non-virtual IPv4 site-local interface qualifies: probing through tun/gre/loopback
     * would send the SSDP burst into a VPN tunnel where no TV lives, and would still burn the window.
     */
    static boolean isLanCandidate(@Nullable NetworkInterface nic) {
        if (nic == null) {
            return false;
        }
        try {
            if (!nic.isUp() || nic.isLoopback() || nic.isPointToPoint() || nic.isVirtual()) {
                return false;
            }
            Enumeration<InetAddress> addresses = nic.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                    return true;
                }
            }
        } catch (IOException | RuntimeException ex) {
            return false;
        }
        return false;
    }

    private static List<NetworkInterface> candidateInterfaces() {
        List<NetworkInterface> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            while (all != null && all.hasMoreElements() && out.size() < MAX_PROBE_INTERFACES) {
                NetworkInterface nic = all.nextElement();
                if (isLanCandidate(nic)) {
                    out.add(nic);
                }
            }
        } catch (IOException | RuntimeException ex) {
            Logger.warn("PrismCastSsdp", "网络接口枚举失败：" + ex.getMessage());
        }
        return out;
    }

    private void collect(MulticastSocket socket, List<Device> found) {
        Set<String> seen = new LinkedHashSet<>();
        long deadline = System.currentTimeMillis() + WINDOW_MS;
        while (found.size() < MAX_DEVICES && !cancelled) {
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) {
                break;
            }
            try {
                socket.setSoTimeout((int) Math.min(remaining, Integer.MAX_VALUE));
                byte[] buffer = new byte[DATAGRAM_BYTES];
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                adopt(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8), found, seen);
            } catch (SocketTimeoutException ex) {
                break;
            } catch (IOException | RuntimeException ex) {
                // stopDiscovery closed the socket, or a malformed datagram arrived. Either way the window ends.
                break;
            }
        }
    }

    /** Turns one received datagram into at most one device; replies we already saw, and our own echo, drop out. */
    private void adopt(String message, List<Device> found, Set<String> seen) {
        if (!message.startsWith("HTTP/")) {
            return;
        }
        String location = UpnpDescription.headerOf(message, "location");
        if (location == null) {
            return;
        }
        if (!seen.add(location.toLowerCase(Locale.ROOT))) {
            return;
        }
        Device device = describe(location, UpnpDescription.headerOf(message, "usn"));
        if (device != null) {
            found.add(device);
        }
    }

    /** {@code @Nullable} by contract: an unparseable or off-LAN "device" is reported as absent, not broken. */
    @Nullable
    private Device describe(String location, @Nullable String usn) {
        String host = LanAddressPolicy.hostOf(location);
        if (host == null || !LanAddressPolicy.isPrivateHost(host)) {
            return null;
        }
        String description;
        try {
            // Raw socket even here (H1): a description document is served over cleartext http on the TV.
            description = SoapController.get(location);
        } catch (SoapController.ControlException ex) {
            return null;
        }
        String controlUrl = UpnpDescription.controlUrlOf(description, location);
        if (controlUrl == null || !LanAddressPolicy.isPrivateHost(LanAddressPolicy.hostOf(controlUrl))) {
            return null;
        }
        return new Device(UpnpDescription.idOf(usn, location), UpnpDescription.nameOf(description, host),
                host, UpnpDescription.portOf(location), controlUrl, location);
    }
}
