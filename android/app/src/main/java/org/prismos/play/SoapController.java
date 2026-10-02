package org.prismos.play;

import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

/**
 * H1 (SPEC §1.5.2.1) — AVTransport control over a bare {@code java.net.Socket}, and the destination gate in
 * front of it. Message shapes live in {@link SoapEnvelope}; discovery lives in {@link SsdpDiscovery}.
 *
 * WHY A RAW SOCKET, AND WHY THAT IS ALLOWED HERE (Master 已于 2026-10-03 单独签核):
 * {@code res/xml/network_security_config.xml} declares {@code cleartextTrafficPermitted="false"} and the
 * manifest declares {@code usesCleartextTraffic="false"}. That policy is enforced by {@code
 * NetworkSecurityPolicy} as consumed by OkHttp / HttpURLConnection, which refuse cleartext connections — the
 * platform keeps the *library* stack honest. UPnP control is cleartext HTTP by specification, and the config
 * cannot whitelist a LAN range: {@code <domain>} takes literals only while the TV's address is DHCP-dynamic
 * (that dead end is H3). So no policy-conformant route exists. This class writes the HTTP/1.1 request bytes
 * itself. The manifest and the security config are NOT relaxed — they stay strict, which keeps
 * "明文策略未放宽" a verifiable half of AC-24.
 *
 * THREE CONDITIONS make the bypass safe, each enforced in code rather than in prose:
 *   1. a destination is only ever a host this device just learnt from its OWN SSDP probe replies;
 *   2. it must parse as an RFC1918 dotted-quad literal ({@link LanAddressPolicy#isPrivateHost}). Hostnames
 *      (DNS can land anywhere), IPv6, loopback, link-local and all public ranges are refused, and because
 *      the peer is a literal address {@code connect()} performs no lookup that could be redirected;
 *   3. JavaScript never supplies a host: {@link PrismCastPlugin} re-reads the control URL from its own
 *      discovery registry by device id, and {@link #sendOnce} re-validates the literal at send time anyway,
 *      because the URL round-trips through the WebView and cannot be assumed untouched.
 *
 * The media is NOT fetched here. The pushed stream must be the public HTTPS edge proxy handle
 * ({@link LanAddressPolicy#requirePublicStreamUrl}), so the only cleartext on the LAN is the control plane.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Review-only.
 */
final class SoapController {

    private static final int CONNECT_TIMEOUT_MS = 2_000;
    private static final int READ_TIMEOUT_MS = 6_000;
    /** A peer answering larger than this is not a DLNA renderer talking to us. */
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;

    private SoapController() {}

    /** Raised for every refusal and every transport failure; the message is user-safe and reaches the UI. */
    static final class ControlException extends Exception {
        ControlException(String message) {
            super(message);
        }

        ControlException(String message, @Nullable Throwable cause) {
            super(message, cause);
        }
    }

    // ---- transport ----------------------------------------------------------------------------------

    /** GET used by {@link SsdpDiscovery} to read a device description document off the LAN. */
    static String get(String url) throws ControlException {
        return exchange(url, "GET", null, null);
    }

    /** The two-call DLNA handshake: load the item, then start it. */
    static void castTo(String controlUrl, String streamUrl, @Nullable String title, @Nullable String mimeType)
            throws ControlException {
        LanAddressPolicy.requirePublicStreamUrl(streamUrl);
        sendOnce(controlUrl, SoapEnvelope.ACTION_SET_URI, streamUrl, title, mimeType);
        sendOnce(controlUrl, SoapEnvelope.ACTION_PLAY, null, title, mimeType);
    }

    static void control(String controlUrl, String action) throws ControlException {
        sendOnce(controlUrl, action, null, null, null);
    }

    private static void sendOnce(String controlUrl, String action, @Nullable String streamUrl,
                                 @Nullable String title, @Nullable String mimeType) throws ControlException {
        String target = controlUrl.trim();
        // Re-checked at send time, not only at discovery time: the control URL round-trips through
        // JavaScript, so this side cannot assume the string it was handed was never touched.
        if (!LanAddressPolicy.isPrivateHost(LanAddressPolicy.hostOf(target))) {
            throw new ControlException("控制地址不属于本机发现结果内的局域网设备");
        }
        exchange(target, "POST", SoapEnvelope.envelopeFor(action, streamUrl, title, mimeType),
                SoapEnvelope.soapActionHeader(action));
    }

    /**
     * One hand-written HTTP/1.1 exchange. {@code Connection: close} is deliberate: it makes "read to EOF"
     * unambiguous, so a renderer that omits {@code Content-Length} (several do) cannot hang the scan thread.
     */
    private static String exchange(String url, String verb, @Nullable String body, @Nullable String soapAction)
            throws ControlException {
        URI target = parseTarget(url);
        String host = target.getHost();
        int port = target.getPort() > 0 ? target.getPort()
                : ("https".equals(schemeOf(target)) ? 443 : 80);
        String path = target.getRawPath() == null || target.getRawPath().isEmpty()
                ? "/" : target.getRawPath();
        if (target.getRawQuery() != null) {
            path = path + "?" + target.getRawQuery();
        }
        byte[] payload = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder(256);
        head.append(verb).append(' ').append(path).append(" HTTP/1.1\r\n")
                .append("Host: ").append(host).append(':').append(port).append("\r\n")
                .append("User-Agent: PrismPlay/2.1 DLNA/1.0\r\n")
                .append("Accept: */*\r\n")
                .append("Connection: close\r\n");
        if (body != null) {
            head.append("Content-Type: text/xml; charset=\"utf-8\"\r\n")
                    .append("SOAPAction: \"").append(soapAction).append("\"\r\n")
                    .append("Content-Length: ").append(payload.length).append("\r\n");
        }
        head.append("\r\n");
        try (Socket socket = new Socket()) {
            // Host validated as a dotted-quad literal above, so connect() resolves nothing and cannot be
            // pointed at a name that a rogue DNS answer would move.
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(READ_TIMEOUT_MS);
            OutputStream out = socket.getOutputStream();
            out.write(head.toString().getBytes(StandardCharsets.UTF_8));
            if (payload.length > 0) {
                out.write(payload);
            }
            out.flush();
            return readResponse(socket.getInputStream());
        } catch (SocketTimeoutException ex) {
            throw new ControlException("大屏在预期时间内没有应答", ex);
        } catch (InterruptedIOException ex) {
            throw new ControlException("投屏请求已取消", ex);
        } catch (IOException ex) {
            throw new ControlException("无法连接该局域网设备", ex);
        }
    }

    private static URI parseTarget(String url) throws ControlException {
        URI parsed;
        try {
            parsed = new URI(url);
        } catch (URISyntaxException ex) {
            throw new ControlException("设备控制地址无法解析", ex);
        }
        String scheme = schemeOf(parsed);
        if (parsed.getHost() == null || (!"http".equals(scheme) && !"https".equals(scheme))) {
            throw new ControlException("设备控制地址必须是局域网 http 端点");
        }
        return parsed;
    }

    private static String schemeOf(URI uri) {
        return uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    }

    /**
     * Status line and headers are read as ISO-8859-1 exactly as RFC 9112 requires, which also makes every
     * header char index equal to its byte index — that is what lets the Content-Length arithmetic below be
     * exact. The body is then decoded by the charset the peer declared, never by the header's assumption:
     * a Xiaomi TV's {@code friendlyName} is Chinese text inside a UTF-8 document, and decoding it as the
     * header charset (or as ISO-8859-1, as several DLNA libraries do) is how "客厅的小米电视" reaches the user
     * as mojibake.
     */
    private static String readResponse(InputStream input) throws ControlException, IOException {
        ByteArrayOutputStream read = new ByteArrayOutputStream(2048);
        byte[] buffer = new byte[4096];
        int headerEnd = -1;
        int expected = -1;
        int total = 0;
        while (total < MAX_RESPONSE_BYTES) {
            int got = input.read(buffer, 0, Math.min(buffer.length, MAX_RESPONSE_BYTES - total));
            if (got < 0) {
                break;
            }
            read.write(buffer, 0, got);
            total += got;
            if (headerEnd < 0) {
                String soFar = read.toString(StandardCharsets.ISO_8859_1.name());
                int boundary = soFar.indexOf("\r\n\r\n");
                if (boundary >= 0) {
                    headerEnd = boundary + 4;
                    expected = contentLengthOf(soFar.substring(0, boundary));
                }
            }
            if (expected >= 0 && total - headerEnd >= expected) {
                break;
            }
        }
        if (headerEnd < 0) {
            // No header terminator at all: the peer is not speaking HTTP. Say so instead of returning noise.
            throw new ControlException("设备返回的不是合法 HTTP 应答");
        }
        byte[] raw = read.toByteArray();
        String headBlock = new String(raw, 0, headerEnd, StandardCharsets.ISO_8859_1);
        int status = statusOf(headBlock.substring(0, headBlock.indexOf("\r\n")));
        byte[] body = Arrays.copyOfRange(raw, headerEnd, raw.length);
        if (status < 200 || status >= 300) {
            String text = decodeBody(body, charsetOf(headBlock));
            throw new ControlException("大屏拒绝了该指令（HTTP " + status + "）" + SoapEnvelope.faultOf(text));
        }
        return decodeBody(body, charsetOf(headBlock));
    }

    /** The {@code charset=} parameter of the header block, or null when the peer declared none. */
    @Nullable
    private static String charsetOf(String headBlock) {
        for (String line : headBlock.split("\r\n")) {
            String lowered = line.toLowerCase(Locale.ROOT);
            if (!lowered.startsWith("content-type:")) {
                continue;
            }
            int at = lowered.indexOf("charset=");
            if (at < 0) {
                return null;
            }
            String value = line.substring(line.indexOf("charset=", at) + "charset=".length()).trim();
            int end = value.indexOf(';');
            if (end >= 0) {
                value = value.substring(0, end).trim();
            }
            value = value.replace("\"", "").replace("'", "");
            return value.isEmpty() ? null : value;
        }
        return null;
    }

    /** HTTP parameter, then the XML prolog, then UTF-8 — the order the peer actually declares in. */
    private static String decodeBody(byte[] body, @Nullable String declared) {
        String candidate = declared;
        if (candidate == null || candidate.isEmpty()) {
            candidate = prologEncodingOf(body);
        }
        if (candidate == null || candidate.isEmpty()) {
            return new String(body, StandardCharsets.UTF_8);
        }
        try {
            return new String(body, Charset.forName(candidate));
        } catch (RuntimeException ex) {
            // A renderer naming a charset Java has never heard of: UTF-8 is the only sensible guess.
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    /** {@code <?xml ... encoding="utf-8"?>} peeked at in ASCII, which is all a prolog can be. */
    @Nullable
    private static String prologEncodingOf(byte[] body) {
        String head = new String(body, 0, Math.min(body.length, 200), StandardCharsets.US_ASCII);
        int at = head.indexOf("encoding=");
        if (at < 0 || head.indexOf('<', 0) != 0) {
            return null;
        }
        int end = head.indexOf('>', at);
        String value = head.substring(at + "encoding=".length(), end < 0 ? head.length() : end).trim();
        value = value.replace("\"", "").replace("'", "").trim();
        return value.isEmpty() ? null : value;
    }

    private static int statusOf(String statusLine) throws ControlException {
        String[] tokens = statusLine.split(" ");
        if (tokens.length < 2 || !tokens[0].startsWith("HTTP/")) {
            throw new ControlException("设备应答状态行无法解析");
        }
        try {
            return Integer.parseInt(tokens[1]);
        } catch (NumberFormatException ex) {
            throw new ControlException("设备应答状态行无法解析");
        }
    }

    private static int contentLengthOf(String headBlock) {
        for (String line : headBlock.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && "content-length".equalsIgnoreCase(line.substring(0, colon).trim())) {
                try {
                    return Integer.parseInt(line.substring(colon + 1).trim());
                } catch (NumberFormatException ignored) {
                    return -1;
                }
            }
        }
        return -1;
    }
}
