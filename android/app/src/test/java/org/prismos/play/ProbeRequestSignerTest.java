package org.prismos.play;

import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import static org.junit.Assert.*;

public final class ProbeRequestSignerTest {
    @Test public void includesBodyDigestAndTimestamp() throws Exception {
        Map<String, String> result = ProbeRequestSigner.sign("aid=8662&app_name=novelread",
            "{\"test\":1}".getBytes(StandardCharsets.UTF_8), 1791228811000L);
        assertEquals("1791228811", result.get("X-Khronos"));
        assertEquals("1791228811000", result.get("X-SS-Req-Ticket"));
        assertEquals(32, result.get("X-SS-STUB").length());
        assertEquals("8404401c0000e28e367b09d8142b7022103fad22c9297657aaae", result.get("X-Gorgon"));
        assertEquals(52, result.get("X-Gorgon").length());
        assertTrue(result.get("X-Gorgon").startsWith("8404401c0000"));
    }

    @Test public void ticketMustParticipateInSignature() throws Exception {
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        Map<String, String> first = ProbeRequestSigner.sign("aid=8662&_rticket=1000", body, 1000);
        Map<String, String> second = ProbeRequestSigner.sign("aid=8662&_rticket=1001", body, 1000);
        assertNotEquals(first.get("X-Gorgon"), second.get("X-Gorgon"));
    }

    @Test public void generatedIdentityIsNineteenDigits() {
        assertTrue(ProbeRequestSigner.deviceId().matches("[0-9]{19}"));
    }
}
