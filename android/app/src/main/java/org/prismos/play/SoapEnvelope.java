package org.prismos.play;

import androidx.annotation.Nullable;
import java.util.Locale;

/**
 * The message half of the DLNA control plane (SPEC §1.5.2, AC-24): every byte of SOAP and DIDL markup this
 * app emits is built here and nowhere else, so there is a single authority for the wire shape while
 * {@link SoapController} owns only the destination gate and the transport.
 *
 * Two rules that are easy to get wrong, made structural rather than advised:
 *   1. element names come only from this class's own {@code ACTION_*} constants. The caller's verb is mapped
 *      through the closed switch in {@link SoapController#actionOf}, so a page can never name an arbitrary
 *      XML element by string concatenation.
 *   2. catalogue text is renderer data, not markup: {@link #escape} is applied to everything that entered
 *      this process from outside it — including the DIDL document placed inside {@code CurrentURIMetaData},
 *      which is markup-as-a-string and therefore gets escaped a second time on purpose.
 *
 * Nothing here touches the network, so the shapes below are the same ones the protocol tests pin down.
 *
 * NOTHING HERE HAS EVER RUN: no JDK, Gradle or Android SDK on the authoring machine. Review-only.
 */
final class SoapEnvelope {

    static final String AVTRANSPORT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1";
    static final String ACTION_SET_URI = "SetAVTransportURI";
    static final String ACTION_PLAY = "Play";
    static final String ACTION_PAUSE = "Pause";
    static final String ACTION_STOP = "Stop";

    private static final String ENVELOPE_OPEN = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\""
            + " s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>";
    private static final String ENVELOPE_CLOSE = "</s:Body></s:Envelope>";

    private SoapEnvelope() {}

    /**
     * Loads the item. Renderers differ on how strict they are about {@code CurrentURIMetaData}: some refuse a
     * bare URI outright, so a DIDL-Lite banner travels with it, and {@code protocolInfo} names the container
     * when {@code PlaybackInfo} supplied a MIME type.
     */
    static String setUriEnvelope(String streamUrl, @Nullable String title, @Nullable String mimeType) {
        return ENVELOPE_OPEN + "<u:" + ACTION_SET_URI + " xmlns:u=\"" + AVTRANSPORT_SERVICE + "\">"
                + "<InstanceID>0</InstanceID>"
                + "<CurrentURI>" + escape(streamUrl) + "</CurrentURI>"
                + "<CurrentURIMetaData>" + escape(didlLite(title, streamUrl, mimeType)) + "</CurrentURIMetaData>"
                + "</u:" + ACTION_SET_URI + ">" + ENVELOPE_CLOSE;
    }

    /** Play carries {@code Speed}; Pause and Stop take only {@code InstanceID} (AVTransport:1). */
    static String transportEnvelope(String action) {
        String body = "<InstanceID>0</InstanceID>" + (ACTION_PLAY.equals(action) ? "<Speed>1</Speed>" : "");
        return ENVELOPE_OPEN + "<u:" + action + " xmlns:u=\"" + AVTRANSPORT_SERVICE + "\">"
                + body + "</u:" + action + ">" + ENVELOPE_CLOSE;
    }

    /** {@code SOAPAction} header value: the service URN, a {@code #}, then the action name. */
    static String soapActionHeader(String action) {
        return AVTRANSPORT_SERVICE + "#" + action;
    }

    /**
     * Closed mapping from the JS verb to an action name. An unrecognised verb is refused rather than
     * sanitised, because the action name becomes an XML element name below.
     */
    static String actionOf(@Nullable String requested) throws SoapController.ControlException {
        String value = requested == null ? "" : requested.trim();
        if (ACTION_PLAY.equalsIgnoreCase(value)) {
            return ACTION_PLAY;
        }
        if (ACTION_PAUSE.equalsIgnoreCase(value)) {
            return ACTION_PAUSE;
        }
        if (ACTION_STOP.equalsIgnoreCase(value)) {
            return ACTION_STOP;
        }
        throw new SoapController.ControlException("不支持的投屏控制指令");
    }

    /** Action dispatch: the only route by which an action name reaches the markup builders above. */
    static String envelopeFor(String action, @Nullable String streamUrl, @Nullable String title,
                              @Nullable String mimeType) throws SoapController.ControlException {
        if (ACTION_SET_URI.equals(action)) {
            if (streamUrl == null) {
                throw new SoapController.ControlException("缺少投屏地址");
            }
            return setUriEnvelope(streamUrl, title, mimeType);
        }
        if (ACTION_PLAY.equals(action) || ACTION_PAUSE.equals(action) || ACTION_STOP.equals(action)) {
            return transportEnvelope(action);
        }
        throw new SoapController.ControlException("不支持的投屏指令");
    }

    static String didlLite(@Nullable String title, String streamUrl, @Nullable String mimeType) {
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\""
                + " xmlns:dc=\"http://purl.org/dc/elements/1.1/\""
                + " xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">"
                + "<item id=\"0\" parentID=\"-1\" restricted=\"1\">"
                + "<dc:title>" + escape(title == null || title.trim().isEmpty() ? "光影Play" : title.trim())
                + "</dc:title>"
                + "<upnp:class>object.item.videoItem</upnp:class>"
                + "<res protocolInfo=\"" + protocolInfo(streamUrl, mimeType) + "\">" + escape(streamUrl) + "</res>"
                + "</item></DIDL-Lite>";
    }

    static String protocolInfo(String streamUrl, @Nullable String mimeType) {
        String mime = mimeType == null ? "" : mimeType.trim().toLowerCase(Locale.ROOT);
        String path = streamUrl == null ? "" : streamUrl.toLowerCase(Locale.ROOT);
        if (mime.contains("mpegurl") || mime.contains("x-mpegurl") || path.contains(".m3u8")) {
            return "http-get:*:application/vnd.apple.mpegurl:*";
        }
        if (mime.contains("mp4") || path.contains(".mp4")) {
            return "http-get:*:video/mp4:*";
        }
        // Unknown container: wildcard it rather than lying about the codec, so a strict renderer falls back
        // to sniffing instead of refusing the item outright.
        return "http-get:*:*:*";
    }

    /** Element-text escaping. Attribute values never hold foreign text, by construction. */
    static String escape(@Nullable String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** UPnP's SOAP fault text when the renderer said why — surfaced instead of a bare HTTP 500. */
    static String faultOf(String body) {
        int start = body.indexOf("<faultstring>");
        if (start < 0) {
            return "";
        }
        int end = body.indexOf("</faultstring>", start);
        return end <= start ? "" : "：" + escape(body.substring(start + "<faultstring>".length(), end));
    }
}
