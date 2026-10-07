package org.prismos.play;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class CencFixture {
    static final byte[] KEY = new byte[16];
    static byte[] ints(int... values) {
        ByteBuffer b = ByteBuffer.allocate(values.length * 4);
        for (int v : values) b.putInt(v);
        return b.array();
    }
    static byte[] join(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] p : parts) out.write(p, 0, p.length);
        return out.toByteArray();
    }
    static byte[] text(String s) { return s.getBytes(StandardCharsets.ISO_8859_1); }
    static byte[] box(String name, byte[]... parts) {
        byte[] body = join(parts);
        return join(ints(body.length + 8), text(name), body);
    }
    static byte[] iv(int size) {
        byte[] iv = new byte[size];
        for (int i = 0; i < size; i++) iv[i] = (byte) (i + 1);
        return iv;
    }
    static byte[] track(boolean audio, int ivSize, long position, int size, int[][] subs) {
        byte[] tenc = join(ints(0), new byte[]{0, 0, 1, (byte) ivSize}, new byte[16]);
        byte[] sinf = box("sinf", box("frma", text(audio ? "mp4a" : "avc1")),
                box("schm", ints(0), text("cenc"), ints(65536)), box("schi", box("tenc", tenc)));
        byte[] entry = box(audio ? "enca" : "encv", new byte[audio ? 28 : 78], sinf);
        byte[] subData = new byte[0];
        if (subs != null) {
            ByteBuffer b = ByteBuffer.allocate(2 + subs.length * 6);
            b.putShort((short) subs.length);
            for (int[] sub : subs) b.putShort((short) sub[0]).putInt(sub[1]);
            subData = b.array();
        }
        byte[] chunks = position <= Integer.MAX_VALUE
                ? box("stco", ints(0, 1, (int) position))
                : box("co64", ints(0, 1), ByteBuffer.allocate(8).putLong(position).array());
        byte[] stbl = box("stbl", box("stsd", ints(0, 1), entry),
                box("stsc", ints(0, 1, 1, 1, 1)), box("stsz", ints(0, size, 1)), chunks,
                box("senc", ints(subs == null ? 0 : 2, 1), iv(ivSize), subData),
                box("saiz", ints(0), new byte[]{(byte) (ivSize + subData.length)}, ints(1)),
                box("saio", ints(0, 1, 0)));
        return box("trak", box("mdia", box("minf", stbl)));
    }
    static byte[] plain(int size) {
        byte[] p = new byte[size];
        for (int i = 0; i < size; i++) p[i] = (byte) (i * 7 + 3);
        return p;
    }
    static byte[] encrypt(byte[] plain, int ivSize, int[][] subs) throws Exception {
        Cipher ctr = Cipher.getInstance("AES/CTR/NoPadding");
        ctr.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(KEY, "AES"),
                new IvParameterSpec(Arrays.copyOf(iv(ivSize), 16)));
        if (subs == null) return ctr.doFinal(plain);
        byte[] result = plain.clone();
        ByteArrayOutputStream cipherInput = new ByteArrayOutputStream();
        int pos = 0;
        for (int[] sub : subs) {
            pos += sub[0];
            cipherInput.write(plain, pos, sub[1]);
            pos += sub[1];
        }
        byte[] encrypted = ctr.doFinal(cipherInput.toByteArray());
        pos = 0;
        int stream = 0;
        for (int[] sub : subs) {
            pos += sub[0];
            System.arraycopy(encrypted, stream, result, pos, sub[1]);
            pos += sub[1];
            stream += sub[1];
        }
        return result;
    }
    static int find(byte[] data, String type) {
        byte[] t = text(type);
        outer: for (int i = 0; i <= data.length - 4; i++) {
            for (int j = 0; j < 4; j++) if (data[i + j] != t[j]) continue outer;
            if (i < 4) continue;
            int size = ByteBuffer.wrap(data).getInt(i - 4);
            if (size < 8 || size > data.length - (i - 4)) continue;
            return i;
        }
        throw new AssertionError(type);
    }
    static byte[] multiSampleTrack() {
        byte[] one = track(false, 8, 4096, 17, null);
        int stblType = find(one, "stbl");
        int stblStart = stblType - 4;
        int p = stblStart + 8;
        int stblEnd = stblStart + ByteBuffer.wrap(one).getInt(stblStart);
        ByteArrayOutputStream tables = new ByteArrayOutputStream();
        while (p < stblEnd) {
            int size = ByteBuffer.wrap(one).getInt(p);
            String type = new String(one, p + 4, 4, StandardCharsets.ISO_8859_1);
            byte[] replacement;
            switch (type) {
                case "stsc": replacement = box(type, ints(0, 2, 1, 2, 1, 2, 1, 1)); break;
                case "stsz": replacement = box(type, ints(0, 0, 3, 17, 23, 31)); break;
                case "stco": replacement = box(type, ints(0, 2, 4096, 5000)); break;
                case "senc": replacement = box(type, ints(0, 3), iv(8), iv(8), iv(8)); break;
                case "saiz": replacement = box(type, ints(0), new byte[]{8}, ints(3)); break;
                default: replacement = Arrays.copyOfRange(one, p, p + size);
            }
            tables.write(replacement, 0, replacement.length);
            p += size;
        }
        return box("trak", box("mdia", box("minf", box("stbl", tables.toByteArray()))));
    }
    private CencFixture() { }
}
