package org.prismos.play;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class CencBoxes {
    static final int LIMIT = 500000;
    static final class Box {
        final int start, payload, end;
        final String type;
        Box(int start, int payload, int end, String type) {
            this.start = start; this.payload = payload; this.end = end; this.type = type;
        }
    }
    static void check(boolean ok, String message) throws IOException {
        if (!ok) throw new IOException(message);
    }
    static void need(int pos, int size, int end) throws IOException {
        check(pos >= 0 && size >= 0 && pos <= end && size <= end - pos, "Truncated MP4 data");
    }
    static long u32(byte[] b, int p) {
        return ((long) (b[p] & 255) << 24) | ((long) (b[p + 1] & 255) << 16)
                | ((long) (b[p + 2] & 255) << 8) | (b[p + 3] & 255);
    }
    static long u64(byte[] b, int p) throws IOException {
        check((b[p] & 128) == 0, "Unsigned offset exceeds signed long");
        return (u32(b, p) << 32) | u32(b, p + 4);
    }
    static String type(byte[] b, int p) {
        return new String(b, p, 4, StandardCharsets.ISO_8859_1);
    }
    static Box box(byte[] b, int p, int end) throws IOException {
        need(p, 8, end);
        long size = u32(b, p);
        int header = 8;
        if (size == 1) { need(p, 16, end); size = u64(b, p + 8); header = 16; }
        if (size == 0) size = end - p;
        check(size >= header && size <= end - p, "Invalid or truncated MP4 box");
        return new Box(p, p + header, p + (int) size, type(b, p + 4));
    }
    static List<Box> children(byte[] b, int start, int end) throws IOException {
        List<Box> result = new ArrayList<>();
        for (int p = start; p < end;) {
            check(result.size() < LIMIT, "Too many MP4 boxes");
            Box box = box(b, p, end);
            check(!box.type.equals("moof") && !box.type.equals("mvex"), "Fragmented MP4 unsupported");
            result.add(box); p = box.end;
        }
        return result;
    }
    static Box find(List<Box> boxes, String type, boolean required) throws IOException {
        Box result = null;
        for (Box b : boxes) if (b.type.equals(type)) {
            check(result == null, "Duplicate " + type); result = b;
        }
        check(!required || result != null, "Missing " + type);
        return result;
    }
    static List<Box> inside(byte[] data, Box b) throws IOException {
        return children(data, b.payload, b.end);
    }
    static int full(byte[] b, Box box, int version, int allowedFlags) throws IOException {
        need(box.payload, 4, box.end);
        long value = u32(b, box.payload);
        check((value >>> 24) == version && ((value & 16777215) & ~allowedFlags) == 0,
                "Unsupported " + box.type + " version/flags");
        return (int) value & 16777215;
    }
    static int count(byte[] b, int p, int end, int width) throws IOException {
        need(p, 4, end);
        long n = u32(b, p);
        check(n <= LIMIT && (width == 0 || n <= (end - p - 4) / width), "Invalid table count");
        return (int) n;
    }
    static void finish(int p, Box box) throws IOException {
        check(p == box.end, "Unexpected " + box.type + " payload length");
    }
    static void rename(byte[] b, Box box, String name) {
        byte[] t = name.getBytes(StandardCharsets.ISO_8859_1);
        System.arraycopy(t, 0, b, box.start + 4, 4);
    }
    static long add(long a, long b) throws IOException {
        check(a >= 0 && b >= 0 && a <= Long.MAX_VALUE - b, "File position overflow");
        return a + b;
    }
    private CencBoxes() { }
}
