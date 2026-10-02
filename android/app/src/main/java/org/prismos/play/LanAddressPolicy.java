package org.prismos.play;

import androidx.annotation.Nullable;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * The destination policy that licenses H1's cleartext socket (SPEC §1.5.2.1, AC-24 "明文策略未放宽").
 *
 * Deliberately kept out of {@link SoapController} so the rule and the transport cannot be changed together by
 * accident: relaxing this class is the single, reviewable thing that would widen cleartext reach, and it is
 * the reason the manifest can keep {@code usesCleartextTraffic="false"} and
 * {@code network_security_config.xml} can keep {@code cleartextTrafficPermitted="false"} (H3: Android's
 * security config cannot express a LAN range — {@code <domain>} takes literals only, and the TV's address is
 * DHCP-dynamic — so the whitelist simply cannot be built the platform-sanctioned way).
 *
 * The rule is closed, not a blocklist. Only 10/8, 172.16/12 and 192.168/16 written as a dotted-quad literal
 * are allowed; everything else — public addresses, hostnames (a name can be made to resolve anywhere by
 * DNS), IPv6 literals, loopback, link-local, {@code 0.0.0.0} — is refused. Consequences worth stating
 * plainly: an IPv6-only or 169.254 (Wi-Fi Direct) renderer is therefore NOT castable by this build, and a
 * TV on a different subnet or behind a guest-network AP isolation is not either. Both are honest limits of
 * the RFC1918 rule, not bugs to be fixed by loosening it.
 *
 * A host name never reaches a socket without passing through here, and {@link PrismCastPlugin} only ever
 * hands out control URLs that this device discovered itself. The TypeScript mirror in
 * {@code src/core/native/cast.ts} applies the same predicate to the payload coming back UP from native, so
 * a tampered WebView cannot present a public host as if it were a discovered TV.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Review-only.
 */
final class LanAddressPolicy {

    private LanAddressPolicy() {}

    /** True only for an RFC1918 dotted-quad literal. See the class header for what is refused and why. */
    static boolean isPrivateHost(@Nullable String host) {
        if (host == null) {
            return false;
        }
        String literal = host.trim();
        // A colon means IPv6 (or a mistyped host:port); brackets mean an IPv6 literal. Both are refused.
        if (literal.isEmpty() || literal.charAt(0) == '[' || literal.indexOf(':') >= 0) {
            return false;
        }
        String[] parts = literal.split("\\.");
        if (parts.length != 4) {
            return false;
        }
        int[] octet = new int[4];
        for (int index = 0; index < 4; index++) {
            String part = parts[index];
            // Leading zeros are refused outright: some resolvers read "010." as octal, which would turn a
            // rejected-looking string into 8.0.0.0 — exactly the kind of gap a closed rule must not leave.
            if (part.isEmpty() || part.length() > 3 || (part.length() > 1 && part.charAt(0) == '0')) {
                return false;
            }
            for (int cursor = 0; cursor < part.length(); cursor++) {
                if (part.charAt(cursor) < '0' || part.charAt(cursor) > '9') {
                    return false;
                }
            }
            octet[index] = Integer.parseInt(part);
            if (octet[index] > 255) {
                return false;
            }
        }
        if (octet[0] == 10) {
            return true;
        }
        if (octet[0] == 172) {
            return octet[1] >= 16 && octet[1] <= 31;
        }
        return octet[0] == 192 && octet[1] == 168;
    }

    /** The lowercased host of an http(s) URL, without the port; null for anything else, including garbage. */
    @Nullable
    static String hostOf(@Nullable String url) {
        if (url == null) {
            return null;
        }
        try {
            URI parsed = new URI(url.trim());
            String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.ROOT);
            if (parsed.getHost() == null || (!"http".equals(scheme) && !"https".equals(scheme))) {
                return null;
            }
            return parsed.getHost().toLowerCase(Locale.ROOT);
        } catch (URISyntaxException ex) {
            return null;
        }
    }

    /**
     * The stream the TV pulls must be the edge's public HTTPS proxy handle, i.e. the very URL
     * {@code api.playback()} hands the phone ({@code https://play.prismos.org/proxy/media/...?exp&sig}).
     * Cleartext is refused so the LAN carries control only; an RFC1918 literal is refused because a private
     * target would mean pushing the TV at something on the user's network instead of at the edge; embedded
     * credentials are refused because a signed handle never needs them. An upstream source address cannot
     * reach here anyway — the client only ever sees the proxy path (AC-02 de-platforming rule).
     */
    static void requirePublicStreamUrl(@Nullable String url) throws SoapController.ControlException {
        String host = hostOf(url);
        if (url == null || host == null || !url.trim().toLowerCase(Locale.ROOT).startsWith("https://")) {
            throw new SoapController.ControlException("投屏地址必须为公网 https 代理流");
        }
        if (isPrivateHost(host)) {
            throw new SoapController.ControlException("投屏地址不得指向局域网主机");
        }
        try {
            if (new URI(url.trim()).getUserInfo() != null) {
                throw new SoapController.ControlException("投屏地址不得内嵌凭据");
            }
        } catch (URISyntaxException ex) {
            throw new SoapController.ControlException("投屏地址不是合法 URL");
        }
    }
}
