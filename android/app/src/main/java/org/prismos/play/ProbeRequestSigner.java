package org.prismos.play;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class ProbeRequestSigner {
    private static final int[] SIGN_MASK = {
        0x44, 0xb9, 0xb9, 0xd9, 0xa4, 0xae, 0xf9, 0xfc, 0xa4, 0x93,
        0xaa, 0x75, 0x7c, 0xa3, 0xc2, 0xc4, 0xa4, 0x96, 0x93, 0x8f
    };
    private static final SecureRandom RANDOM = new SecureRandom();

    private ProbeRequestSigner() {}

    static String deviceId() {
        long value = RANDOM.nextLong() >>> 1;
        return Long.toString(1000000000000000000L + value % 8000000000L);
    }

    static Map<String, String> sign(String query, byte[] body, long nowMs) throws Exception {
        long timestamp = (nowMs / 1000L) & 0xffffffffL;
        byte[] queryHash = md5(query.getBytes(StandardCharsets.UTF_8));
        byte[] payload = new byte[20];
        System.arraycopy(queryHash, 0, payload, 0, 4);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("X-Khronos", Long.toString(timestamp));
        headers.put("X-SS-Req-Ticket", Long.toString(nowMs));
        if (body != null && body.length > 0) {
            byte[] bodyHash = md5(body);
            System.arraycopy(bodyHash, 0, payload, 4, 4);
            headers.put("X-SS-STUB", hex(bodyHash).toUpperCase(Locale.ROOT));
        }
        payload[13] = 6;
        payload[14] = 11;
        payload[15] = 28;
        for (int i = 0; i < 4; i++) payload[16 + i] = (byte) (timestamp >>> (24 - 8 * i));
        for (int i = 0; i < 20; i++) payload[i] = (byte) ((payload[i] & 255) ^ SIGN_MASK[i]);
        for (int i = 0; i < 20; i++) {
            int current = payload[i] & 255;
            int rotated = ((current << 4) | (current >>> 4)) & 255;
            int mixed = rotated ^ (payload[(i + 1) % 20] & 255);
            payload[i] = (byte) ((Integer.reverse(mixed) >>> 24) ^ 255 ^ 20);
        }
        byte[] signature = new byte[26];
        signature[0] = (byte) 0x84;
        signature[1] = 4;
        signature[2] = 0x40;
        signature[3] = 0x1c;
        System.arraycopy(payload, 0, signature, 6, payload.length);
        headers.put("X-Gorgon", hex(signature));
        return headers;
    }

    private static byte[] md5(byte[] bytes) throws Exception {
        return MessageDigest.getInstance("MD5").digest(bytes);
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            result[i * 2] = digits[(bytes[i] & 255) >>> 4];
            result[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(result);
    }
}
