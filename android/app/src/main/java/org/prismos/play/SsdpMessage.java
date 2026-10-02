package org.prismos.play;

/**
 * The SSDP wire format, kept apart from the socket machinery that sends it (SPEC §1.5.2 step 1, AC-24).
 *
 * Splitting the packet from {@link SsdpDiscovery} is not decoration: the packet is the only part of this
 * feature that a standard TV's firmware will judge, so it must be readable as one literal block, and the
 * scan window around it (interfaces, joins, collection) changes for completely different reasons — namely
 * Android's multicast and battery behaviour. Two reasons for one file is how constants end up edited in
 * the wrong place.
 */
final class SsdpMessage {

    /** Reserved SSDP group and port (RFC 4288 / UPnP Device Architecture). */
    static final String MULTICAST_GROUP = "239.255.255.250";
    static final int MULTICAST_PORT = 1900;
    /**
     * MediaRenderer:1 only. Asking for {@code ssdp:all} would drag every DMP, DMS, printer and speaker on
     * the LAN into a sheet whose only purpose is "pick a screen to play on".
     */
    static final String SEARCH_TARGET = "urn:schemas-upnp-org:device:MediaRenderer:1";
    /** Responders may spread their reply over this many seconds; the listen window must exceed it. */
    static final int MX_SECONDS = 2;

    private SsdpMessage() {
    }

    /** The exact probe packet, CRLF-terminated, with the mandatory empty line that closes a request. */
    static String searchRequest() {
        return "M-SEARCH * HTTP/1.1\r\n"
                + "HOST: " + MULTICAST_GROUP + ":" + MULTICAST_PORT + "\r\n"
                + "MAN: \"ssdp:discover\"\r\n"
                + "ST: " + SEARCH_TARGET + "\r\n"
                + "MX: " + MX_SECONDS + "\r\n"
                + "\r\n";
    }
}
