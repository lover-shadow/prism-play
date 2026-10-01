package org.prismos.play;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

/**
 * SPEC 5 尾注 / ARCHITECTURE 3.5: when the player lets the *native* HLS stack fetch a stream, the
 * manifest's child requests (segments, keys, subtitles) are issued by the media framework and cannot
 * carry custom headers. Private admission needs both Authorization and X-Private-Session on EVERY
 * sub-request, so the credentials have to be attached in-process, by the same code that owns them.
 * That is this class: a Capacitor WebViewClient that forwards /proxy/* and adds the headers.
 *
 * DISABLED BY DEFAULT, AND IT MUST STAY THAT WAY UNTIL A PHONE PROVES IT.
 * The single gate is the plugin config flag "privilegedProxyEnabled" (capacitor.config.ts ->
 * plugins.PrismNative.privilegedProxyEnabled). SPEC 5 keeps 个人探索 streaming closed until
 * per-sub-request admission is demonstrated on a device (G2/G3 exit criteria), so the client is only
 * installed when that flag is explicitly true. Reviewers hunting for the switch: it is read in
 * PrismNativePlugin.load() and installed from there; the default is false and no user-facing setting
 * turns it on.
 *
 * THREE PROPERTIES ENFORCED BELOW RATHER THAN ASSUMED:
 *  1. host allowlist - only play.prismos.org, plus same-site requests the player addressed to the app's
 *     own https origin (those get rewritten to the edge). Anything else falls through to Capacitor's
 *     normal client, so this can never become an open header-adding proxy or leak the JWT off-site.
 *  2. redirects are never followed: HttpURLConnection would re-send custom headers to the redirect
 *     target, which may be another host. A 3xx is refused with 502 instead.
 *  3. no body buffering: the upstream stream is handed straight to the WebView, so Range/206 seeking
 *     works and memory does not scale with segment size.
 *
 * WHY X-Private-Session IS STILL INERT HERE (deliberate, not a forgotten TODO): the private session
 * credential is RAM-only on the TypeScript side (AC-02 严禁持久化) and the PrismNative contract has no
 * method that hands it to native - SecureCredentialStore even refuses session-shaped key names so it
 * cannot be smuggled through secureWrite. Wiring the second header needs a contract decision plus an
 * OpenAPI/SPEC update first. Until then this class can only satisfy the Authorization half, which is
 * insufficient for private admission, so private native-HLS streaming remains closed exactly as SPEC 5
 * demands. Public media needs no header at all, so nothing in the shipped scope depends on this path.
 */
public final class PrivilegedServerProxy extends BridgeWebViewClient {

    /** capacitor.config.ts key under plugins.PrismNative. Absent or false means fully inert. */
    public static final String CONFIG_FLAG = "privilegedProxyEnabled";

    private static final String EDGE_HOST = "play.prismos.org";
    private static final String EDGE_SCHEME = "https";
    private static final String PROXY_PREFIX = "/proxy/";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;

    /** Supplies the bearer token from Domain 1 on demand; this class never caches or logs it. */
    public interface AuthorizationSource {
        @Nullable
        String authorization();
    }

    private static volatile boolean enabled = false;
    @Nullable
    private static volatile AuthorizationSource authorizationSource;

    private final String localHost;

    /** Called once from PrismNativePlugin.load(); source may be null when the keystore is unavailable. */
    static void configure(boolean flag, @Nullable AuthorizationSource source) {
        enabled = flag;
        authorizationSource = source;
        Logger.info("PrismProxy", "privileged proxy " + (flag ? "ENABLED" : "disabled (default)"));
    }

    public PrivilegedServerProxy(Bridge bridge, String appHost) {
        super(bridge);
        this.localHost = appHost == null ? "" : appHost;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!enabled || request == null || !isProxyRequest(request.getUrl())) {
            return super.shouldInterceptRequest(view, request);
        }
        try {
            return forward(request);
        } catch (Exception ex) {
            // Fail closed: an unauthenticated fall-through could pull a private segment through the
            // plain network stack. The player reacts by re-resolving the episode, per SPEC 3.1.
            Logger.error("PrismProxy: forward failed for " + request.getUrl().getPath(), ex);
            return refused();
        }
    }

    /** Proxy path on the edge host, or the same path addressed to the app's own origin. */
    private boolean isProxyRequest(@Nullable Uri uri) {
        if (uri == null || uri.isOpaque() || uri.getHost() == null) {
            return false;
        }
        if (uri.getPath() == null || !uri.getPath().startsWith(PROXY_PREFIX)) {
            return false;
        }
        if (!EDGE_SCHEME.equalsIgnoreCase(uri.getScheme())) {
            return false;
        }
        return EDGE_HOST.equalsIgnoreCase(uri.getHost()) || localHost.equalsIgnoreCase(uri.getHost());
    }

    private WebResourceResponse forward(WebResourceRequest request) throws Exception {
        Uri uri = request.getUrl();
        String path = uri.getEncodedPath();
        String query = uri.getEncodedQuery();
        URL target = new URL(EDGE_SCHEME, EDGE_HOST, path + (query == null ? "" : "?" + query));

        HttpsURLConnection connection = (HttpsURLConnection) target.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestMethod("GET");
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "*/*");
        String range = request.getRequestHeaders().get("Range");
        if (range != null && !range.isEmpty()) {
            connection.setRequestProperty("Range", range);
        }
        AuthorizationSource source = authorizationSource;
        String bearer = source == null ? null : source.authorization();
        if (bearer != null && !bearer.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + bearer);
            // connection.setRequestProperty("X-Private-Session", session) is intentionally absent;
            // see the class header for why no session credential may reach native yet.
        }

        int status = connection.getResponseCode();
        if (status >= 300 && status < 400) {
            connection.disconnect();
            Logger.warn("PrismProxy", "redirect refused to keep the bearer token on-host");
            return refused();
        }

        Map<String, String> headers = new HashMap<String, String>();
        // Content-Type is not copied: it travels as the WebResourceResponse mimeType parameter instead,
        // and supplying both lets the platform pick, which is how a wrong encoding once bit us upstream.
        copyHeader(connection, headers, "Content-Range");
        copyHeader(connection, headers, "Accept-Ranges");
        copyHeader(connection, headers, "Cache-Control");
        copyHeader(connection, headers, "ETag");
        copyHeader(connection, headers, "Last-Modified");
        copyHeader(connection, headers, "Content-Length");

        String mime = connection.getContentType();
        InputStream stream = status < HttpURLConnection.HTTP_BAD_REQUEST
                ? connection.getInputStream()
                : connection.getErrorStream();
        // The WebView owns and closes the returned stream; disconnecting here would truncate it.
        if (status == HttpURLConnection.HTTP_OK) {
            return new WebResourceResponse(mime == null ? "application/octet-stream" : mime, null, 200, "OK", headers, stream);
        }
        String phrase = connection.getResponseMessage();
        // The status-code constructor requires a non-empty reason phrase; upstreams do omit it.
        return new WebResourceResponse(mime == null ? "application/octet-stream" : mime, null, status,
                phrase == null || phrase.isEmpty() ? "Prism Proxy" : phrase, headers, stream);
    }

    private static WebResourceResponse refused() {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private static void copyHeader(HttpURLConnection connection, Map<String, String> into, String name) {
        String value = connection.getHeaderField(name);
        if (value != null) {
            into.put(name, value);
        }
    }
}
