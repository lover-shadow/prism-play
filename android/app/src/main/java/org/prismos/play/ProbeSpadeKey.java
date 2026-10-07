package org.prismos.play;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

final class ProbeSpadeKey {
    private ProbeSpadeKey() {}

    static byte[] extract(String value) throws Exception {
        if (value == null || value.isEmpty() || value.length() > 1024) {
            throw new Exception("Invalid key envelope");
        }
        byte[] raw = null;
        byte[] decoded = null;
        byte[] tag = null;
        try {
            raw = Base64.decode(value.trim(), Base64.DEFAULT);
            if (raw.length < 3) throw new Exception("Invalid key envelope");
            int tagLength = ((raw[0] ^ raw[1] ^ raw[2]) & 255) - 48;
            int contentLength = raw.length - tagLength - 1;
            if (tagLength < 1 || contentLength < 33 || contentLength >= raw.length) {
                throw new Exception("Invalid key envelope");
            }
            int seed = (raw[raw.length - tagLength - 2] ^ raw[raw.length - tagLength - 1]) & 255;
            tag = new byte[tagLength];
            for (int i = 0; i < tagLength; i++) tag[i] = (byte) (raw[raw.length - tagLength + i] ^ seed);
            String version = new String(tag, StandardCharsets.UTF_8);
            if (version.equals("app_v2") || version.equals("web_v2")) {
                throw new Exception("Unsupported key envelope");
            }
            decoded = new byte[contentLength];
            int even = 250;
            int odd = 85;
            for (int i = 0; i < contentLength; i++) {
                int current = raw[1 + i] & 255;
                int previous;
                if (i % 2 == 0) { previous = even; even = current; }
                else { previous = odd; odd = current; }
                decoded[i] = (byte) ((previous ^ current) - 21 - Integer.bitCount(i));
            }
            int padding = Character.digit((char) (decoded[0] & 255), 36);
            if (padding < 0 || contentLength - padding - 1 != 32) {
                throw new Exception("Invalid key padding");
            }
            byte[] key = new byte[16];
            for (int i = 0; i < key.length; i++) {
                int high = Character.digit((char) (decoded[1 + i * 2] & 255), 16);
                int low = Character.digit((char) (decoded[2 + i * 2] & 255), 16);
                if (high < 0 || low < 0) {
                    Arrays.fill(key, (byte) 0);
                    throw new Exception("Invalid key encoding");
                }
                key[i] = (byte) ((high << 4) | low);
            }
            return key;
        } finally {
            if (raw != null) Arrays.fill(raw, (byte) 0);
            if (decoded != null) Arrays.fill(decoded, (byte) 0);
            if (tag != null) Arrays.fill(tag, (byte) 0);
        }
    }
}
