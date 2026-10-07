package org.prismos.play;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import static org.prismos.play.CencBoxes.*;

final class CencSampleTable {
    static final class Sample {
        long offset, size;
        byte[] iv;
        long[] clear, cipher;
        Sample(long offset, long size) { this.offset = offset; this.size = size; }
        void wipe() {
            if (iv != null) Arrays.fill(iv, (byte) 0);
            if (clear != null) Arrays.fill(clear, 0);
            if (cipher != null) Arrays.fill(cipher, 0);
            offset = 0; size = 0;
        }
    }
    static List<Sample> parse(byte[] b, List<Box> boxes, CencProtection protection) throws IOException {
        rejectUnsupported(boxes);
        Box stsz = find(boxes, "stsz", true);
        full(b, stsz, 0, 0); need(stsz.payload, 12, stsz.end);
        long uniform = u32(b, stsz.payload + 4);
        int n = count(b, stsz.payload + 8, stsz.end, uniform == 0 ? 4 : 0);
        finish(stsz.payload + 12 + (uniform == 0 ? n * 4 : 0), stsz);
        long[] sizes = new long[n];
        for (int i = 0; i < n; i++) sizes[i] = uniform == 0 ? u32(b, stsz.payload + 12 + i * 4) : uniform;
        Box stco = find(boxes, "stco", false), co64 = find(boxes, "co64", false);
        check((stco == null) != (co64 == null), "Exactly one stco/co64 required");
        Box offsets = stco == null ? co64 : stco;
        int width = stco == null ? 8 : 4;
        full(b, offsets, 0, 0);
        int chunks = count(b, offsets.payload + 4, offsets.end, width);
        finish(offsets.payload + 8 + chunks * width, offsets);
        Box stsc = find(boxes, "stsc", true);
        full(b, stsc, 0, 0);
        int entries = count(b, stsc.payload + 4, stsc.end, 12);
        finish(stsc.payload + 8 + entries * 12, stsc);
        check((n == 0 && chunks == 0 && entries == 0) || (n > 0 && chunks > 0 && entries > 0), "Empty/inconsistent sample tables");
        int[] first = new int[entries], per = new int[entries];
        for (int i = 0; i < entries; i++) {
            int p = stsc.payload + 8 + i * 12;
            long f = u32(b, p), s = u32(b, p + 4), d = u32(b, p + 8);
            check(f >= 1 && f <= chunks && (i == 0 ? f == 1 : f > first[i - 1]), "Invalid stsc first_chunk");
            check(s >= 1 && s <= n && d >= 1 && d <= protection.descriptions, "Invalid stsc sample/description count");
            first[i] = (int) f; per[i] = (int) s;
        }
        List<Sample> samples = new ArrayList<>(n);
        int entry = 0, sample = 0;
        for (int chunk = 1; chunk <= chunks; chunk++) {
            if (entry + 1 < entries && chunk == first[entry + 1]) entry++;
            int p = offsets.payload + 8 + (chunk - 1) * width;
            long position = width == 4 ? u32(b, p) : u64(b, p);
            check(per[entry] <= n - sample, "stsc exceeds stsz sample count");
            for (int j = 0; j < per[entry]; j++) {
                check(sizes[sample] > 0, "Zero-size samples unsupported");
                samples.add(new Sample(position, sizes[sample]));
                position = add(position, sizes[sample++]);
            }
        }
        check(sample == n, "stsc/stsz sample count mismatch");
        Arrays.fill(sizes, 0);
        return samples;
    }
    private static void rejectUnsupported(List<Box> boxes) throws IOException {
        check(find(boxes, "stz2", false) == null, "Compact sample sizes unsupported");
    }
    static void encryption(byte[] b, List<Box> boxes, List<Sample> samples, int ivSize) throws IOException {
        Box senc = find(boxes, "senc", true);
        int flags = full(b, senc, 0, 2);
        int n = count(b, senc.payload + 4, senc.end, ivSize + ((flags & 2) != 0 ? 2 : 0));
        check(n == samples.size(), "senc/stsz sample count mismatch");
        int pos = senc.payload + 8;
        int[] auxiliarySizes = new int[n];
        for (int i = 0; i < n; i++) {
            Sample s = samples.get(i);
            int start = pos;
            need(pos, ivSize, senc.end);
            s.iv = new byte[16]; System.arraycopy(b, pos, s.iv, 0, ivSize); pos += ivSize;
            if ((flags & 2) != 0) {
                need(pos, 2, senc.end);
                int subs = ((b[pos] & 255) << 8) | (b[pos + 1] & 255); pos += 2;
                need(pos, subs * 6, senc.end);
                s.clear = new long[subs]; s.cipher = new long[subs];
                long total = 0;
                for (int j = 0; j < subs; j++) {
                    s.clear[j] = ((b[pos] & 255) << 8) | (b[pos + 1] & 255);
                    s.cipher[j] = u32(b, pos + 2); pos += 6;
                    total = add(total, s.clear[j] + s.cipher[j]);
                }
                check(subs == 0 || total == s.size, "Subsample lengths do not cover sample");
                if (subs == 0) { s.clear = null; s.cipher = null; }
            }
            auxiliarySizes[i] = pos - start;
        }
        finish(pos, senc);
        auxiliary(b, boxes, auxiliarySizes);
        Arrays.fill(auxiliarySizes, 0);
        rename(b, senc, "free");
    }
    private static void auxiliary(byte[] b, List<Box> boxes, int[] sizes) throws IOException {
        Box saiz = find(boxes, "saiz", false), saio = find(boxes, "saio", false);
        if (saiz != null) {
            int flags = full(b, saiz, 0, 1), p = saiz.payload + 4;
            if (flags == 1) { auxiliaryType(b, p, saiz.end); p += 8; }
            need(p, 5, saiz.end);
            int fixed = b[p++] & 255;
            int n = count(b, p, saiz.end, fixed == 0 ? 1 : 0); p += 4;
            check(n == sizes.length, "saiz/senc count mismatch");
            for (int i = 0; i < n; i++) check((fixed == 0 ? b[p++] & 255 : fixed) == sizes[i], "saiz/senc size mismatch");
            finish(p, saiz); rename(b, saiz, "free");
        }
        if (saio != null) {
            need(saio.payload, 4, saio.end);
            int version = b[saio.payload] & 255;
            check(version <= 1, "Unsupported saio version");
            int flags = full(b, saio, version, 1), p = saio.payload + 4;
            if (flags == 1) { auxiliaryType(b, p, saio.end); p += 8; }
            int width = version == 0 ? 4 : 8;
            int n = count(b, p, saio.end, width); p += 4;
            check(n == 1 || (n == 0 && sizes.length == 0), "Unsupported saio entry count");
            for (int i = 0; i < n; i++, p += width) if (width == 8) u64(b, p);
            finish(p, saio); rename(b, saio, "free");
        }
    }
    private static void auxiliaryType(byte[] b, int p, int end) throws IOException {
        need(p, 8, end);
        check(type(b, p).equals("cenc") && u32(b, p + 4) == 0, "Unsupported auxiliary encryption type");
    }
    private CencSampleTable() { }
}
