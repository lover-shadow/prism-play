package org.prismos.play;

import androidx.annotation.Nullable;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Pure parsing of what an SSDP reply and a UPnP device description document actually contain (SPEC §1.5.2
 * step 2: "收集局域网大屏响应，解析 Location XML 获取 AVTransport 控制 URL").
 *
 * Kept free of sockets on purpose. Discovery ({@link SsdpDiscovery}) owns the network, this class owns the
 * text, and because nothing here touches the network it is the half whose rules can be pinned by a fixture —
 * a real Xiaomi/Hisense description document pasted into the protocol test asserts the same behaviour this
 * code will run on a phone.
 *
 * Why the parsing is hand-written rather than a real XML reader: DLNA description documents in the wild are
 * frequently not well-formed XML (undeclared entities, a stray BOM, namespaces bound to nothing, the odd
 * trailing garbage byte after {@code </root>}). A {@code DocumentBuilder} would throw on exactly the devices
 * people own, and the failure would look like "no TV found". The scanning rules below are deliberately
 * tolerant and always case-insensitive on tag names, which is also how the several vendors differ.
 *
 * Tolerance is bounded, though: a device whose control URL cannot be resolved, or whose host fails
 * {@link LanAddressPolicy}, is dropped by the caller rather than listed. Reporting a renderer we cannot
 * control is worse than reporting none.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Review-only.
 */
final class UpnpDescription {

    /** Lower-cased needle marking the AVTransport service inside a description document. */
    private static final String AVTRANSPORT_MARKER = "avtransport:1";
    /** Renderers whose location document answers on no explicit port really are on 80 in this niche. */
    private static final int DEFAULT_LAN_PORT = 80;

    private UpnpDescription() {}

    /** Header value from an SSDP reply, case-insensitive; {@code lowerizedName} must arrive lowercased. */
    @Nullable
    static String headerOf(String message, String lowerizedName) {
        String head = message.split("\r\n\r\n", 2)[0];
        String prefix = lowerizedName + ":";
        for (String line : head.split("\r\n")) {
            if (line.toLowerCase(Locale.ROOT).startsWith(prefix)) {
                return line.substring(prefix.length()).trim();
            }
        }
        return null;
    }

    /**
     * Walks the service list and returns the first resolvable AVTransport control URL. Matching is on the
     * lower-cased URN fragment because vendors differ on {@code <serviceType>} casing and some place the
     * service id before the type; the loop continues past an unusable hit so an earlier RenderingControl-ish
     * entry cannot mask the real AVTransport service.
     */
    @Nullable
    static String controlUrlOf(@Nullable String xml, String base) {
        if (xml == null) {
            return null;
        }
        String lowered = xml.toLowerCase(Locale.ROOT);
        int cursor = 0;
        while (cursor < lowered.length()) {
            int hit = lowered.indexOf(AVTRANSPORT_MARKER, cursor);
            if (hit < 0) {
                return null;
            }
            int serviceEnd = lowered.indexOf("</service>", hit);
            String scope = serviceEnd < 0 ? xml.substring(hit) : xml.substring(hit, serviceEnd);
            String raw = tagValue(scope, "controlurl");
            String resolved = raw == null ? null : resolveAgainst(base, raw);
            if (resolved != null) {
                return resolved;
            }
            cursor = hit + AVTRANSPORT_MARKER.length();
        }
        return null;
    }

    /** Values are taken from the original casing: a control path is case-sensitive, a tag name is not. */
    @Nullable
    static String tagValue(String xml, String lowercasedTag) {
        String lowered = xml.toLowerCase(Locale.ROOT);
        int at = lowered.indexOf("<" + lowercasedTag);
        if (at < 0) {
            return null;
        }
        int start = xml.indexOf('>', at);
        int end = start < 0 ? -1 : lowered.indexOf("</" + lowercasedTag + ">", start);
        if (end < 0) {
            return null;
        }
        String value = xml.substring(start + 1, end).trim();
        return value.isEmpty() ? null : unescapeXml(value);
    }

    /** The {@code friendlyName} is the one piece of this exchange the user reads, so entities come back. */
    static String unescapeXml(String value) {
        return value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
                .replace("&apos;", "'").replace("&amp;", "&");
    }

    /** {@code /upnp/control/av}, {@code upnp/control/av} and an absolute URL are all seen in the wild. */
    @Nullable
    static String resolveAgainst(String base, String path) {
        if (path.isEmpty()) {
            return null;
        }
        String loweredPath = path.toLowerCase(Locale.ROOT);
        if (loweredPath.startsWith("http://") || loweredPath.startsWith("https://")) {
            return path;
        }
        try {
            URI uri = new URI(base);
            if (uri.getHost() == null) {
                return null;
            }
            String scheme = uri.getScheme() == null ? "http" : uri.getScheme();
            int port = uri.getPort() > 0 ? uri.getPort() : DEFAULT_LAN_PORT;
            String origin = scheme + "://" + uri.getHost() + ":" + port;
            if (path.charAt(0) == '/') {
                return origin + path;
            }
            String directory = uri.getPath() == null ? "/" : uri.getPath();
            int slash = directory.lastIndexOf('/');
            String parent = slash < 0 ? "/" : directory.substring(0, slash + 1);
            return origin + parent + (loweredPath.startsWith("./") ? path.substring(2) : path);
        } catch (URISyntaxException | IllegalArgumentException ex) {
            return null;
        }
    }

    /** {@code friendlyName} is what the sheet shows; older stubs only ship {@code modelName}, then the IP. */
    static String nameOf(String description, String fallbackIp) {
        String friendly = tagValue(description, "friendlyname");
        if (friendly != null) {
            return friendly;
        }
        String model = tagValue(description, "modelname");
        return model == null ? fallbackIp : model;
    }

    static int portOf(String location) {
        try {
            int port = new URI(location).getPort();
            return port > 0 ? port : DEFAULT_LAN_PORT;
        } catch (URISyntaxException ex) {
            return DEFAULT_LAN_PORT;
        }
    }

    /**
     * Stable across the duplicate replies one renderer sends: device and service notifications arrive as
     * separate datagrams with different USNs sharing one LOCATION. Hashing the uuid when present and the
     * LOCATION otherwise keeps the sheet at one row per TV and makes re-scan ids comparable.
     */
    static String idOf(@Nullable String usn, String location) {
        String seed = usn == null || usn.trim().isEmpty() ? location : usn.trim();
        int uuid = seed.toLowerCase(Locale.ROOT).indexOf("uuid:");
        String core = uuid < 0 ? seed : seed.substring(uuid);
        return "lan-" + Integer.toHexString(core.toLowerCase(Locale.ROOT).hashCode());
    }
}
