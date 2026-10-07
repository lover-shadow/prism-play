package org.prismos.play;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import static org.prismos.play.CencBoxes.*;
import org.prismos.play.CencSampleTable.Sample;

public final class CencMp4Index {
    private byte[] key, patchedMoov;
    private final long moovOffset;
    private List<Sample> samples;
    private boolean destroyed;

    private CencMp4Index(byte[] moov, long moovOffset, byte[] key, List<Sample> samples) {
        this.patchedMoov = moov; this.moovOffset = moovOffset;
        this.key = key.clone(); this.samples = samples;
    }
    public static CencMp4Index parse(byte[] moov, long moovOffset, byte[] key) throws IOException {
        check(moov != null && key != null && key.length == 16, "CENC requires AES-128 key and moov");
        add(moovOffset, moov.length);
        byte[] patched = moov.clone();
        List<Sample> all = new ArrayList<>();
        List<Sample> occupied = new ArrayList<>();
        byte[] commonKid = null;
        try {
            Box root = box(patched, 0, patched.length);
            check(root.type.equals("moov") && root.end == patched.length, "Expected exactly one complete moov");
            List<Box> roots = inside(patched, root);
            for (Box trak : roots) if (trak.type.equals("trak")) {
                List<Box> track = inside(patched, trak);
                CencProtection.rejectRotation(patched, track);
                Box mdia = find(track, "mdia", true);
                Box minf = find(inside(patched, mdia), "minf", true);
                Box stbl = find(inside(patched, minf), "stbl", true);
                List<Box> tables = inside(patched, stbl);
                CencProtection.rejectRotation(patched, tables);
                CencProtection protection = CencProtection.parse(patched, find(tables, "stsd", true));
                List<Sample> trackSamples = CencSampleTable.parse(patched, tables, protection);
                check(occupied.size() <= LIMIT - trackSamples.size(), "Too many total samples");
                occupied.addAll(trackSamples);
                if (protection.ivSize == 0) {
                    check(find(tables, "senc", false) == null && find(tables, "saiz", false) == null
                            && find(tables, "saio", false) == null, "Encryption metadata without encrypted stsd");
                } else {
                    if (commonKid == null) commonKid = protection.kid.clone();
                    check(Arrays.equals(commonKid, protection.kid), "Multi-key/rotation unsupported");
                    Arrays.fill(protection.kid, (byte) 0);
                    CencSampleTable.encryption(patched, tables, trackSamples, protection.ivSize);
                    all.addAll(trackSamples);
                }
            }
            check(!all.isEmpty(), "No encrypted samples indexed");
            occupied.sort(Comparator.comparingLong(s -> s.offset));
            long previousEnd = 0, moovEnd = add(moovOffset, patched.length);
            for (Sample s : occupied) {
                long end = add(s.offset, s.size);
                check(s.offset >= previousEnd, "Overlapping sample offsets");
                check(end <= moovOffset || s.offset >= moovEnd, "Sample overlaps moov");
                previousEnd = end;
            }
            all.sort(Comparator.comparingLong(s -> s.offset));
            return new CencMp4Index(patched, moovOffset, key, all);
        } catch (IOException | RuntimeException e) {
            Arrays.fill(patched, (byte) 0);
            for (Sample s : occupied) s.wipe();
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException("Invalid CENC index", e);
        } finally {
            if (commonKid != null) Arrays.fill(commonKid, (byte) 0);
        }
    }
    public synchronized void decrypt(byte[] buffer, int offset, int length, long absolutePosition) throws IOException {
        check(!destroyed, "CENC index destroyed");
        check(buffer != null && offset >= 0 && length >= 0 && offset <= buffer.length
                && length <= buffer.length - offset, "Invalid buffer range");
        long end = add(absolutePosition, length);
        if (length == 0) return;
        Cipher aes;
        try {
            aes = Cipher.getInstance("AES/ECB/NoPadding");
            aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
        } catch (GeneralSecurityException e) { throw new IOException("AES unavailable", e); }
        int low = 0, high = samples.size();
        while (low < high) {
            int mid = low + (high - low) / 2;
            Sample s = samples.get(mid);
            if (s.offset + s.size <= absolutePosition) low = mid + 1; else high = mid;
        }
        for (int i = low; i < samples.size(); i++) {
            Sample s = samples.get(i);
            if (s.offset >= end) break;
            if (s.clear == null) overlap(aes, s, buffer, offset, absolutePosition, end, s.offset, s.size, 0);
            else {
                long file = s.offset, stream = 0;
                for (int j = 0; j < s.clear.length; j++) {
                    file += s.clear[j];
                    overlap(aes, s, buffer, offset, absolutePosition, end, file, s.cipher[j], stream);
                    file += s.cipher[j]; stream += s.cipher[j];
                }
            }
        }
        long start = Math.max(absolutePosition, moovOffset), stop = Math.min(end, moovOffset + patchedMoov.length);
        if (start < stop) System.arraycopy(patchedMoov, (int) (start - moovOffset), buffer,
                offset + (int) (start - absolutePosition), (int) (stop - start));
    }
    private static void overlap(Cipher aes, Sample s, byte[] buffer, int offset, long rangeStart,
                                long rangeEnd, long file, long size, long stream) throws IOException {
        long start = Math.max(rangeStart, file), end = Math.min(rangeEnd, file + size);
        if (start >= end) return;
        long cipherPosition = stream + start - file;
        byte[] counter = s.iv.clone(), block = null;
        long carry = cipherPosition / 16;
        for (int i = 15; i >= 0; i--) {
            long sum = (counter[i] & 255) + (carry & 255);
            counter[i] = (byte) sum; carry = (carry >>> 8) + (sum >>> 8);
        }
        int skip = (int) (cipherPosition % 16), p = offset + (int) (start - rangeStart);
        int remaining = (int) (end - start);
        try {
            while (remaining > 0) {
                block = aes.doFinal(counter);
                int n = Math.min(16 - skip, remaining);
                for (int i = 0; i < n; i++) buffer[p++] ^= block[skip + i];
                Arrays.fill(block, (byte) 0);
                remaining -= n; skip = 0;
                for (int i = 15; i >= 0; i--) if (++counter[i] != 0) break;
            }
        } catch (GeneralSecurityException e) { throw new IOException("AES decryption failed", e); }
        finally {
            Arrays.fill(counter, (byte) 0);
            if (block != null) Arrays.fill(block, (byte) 0);
        }
    }
    public synchronized int sampleCount() { return destroyed ? 0 : samples.size(); }
    public synchronized void destroy() {
        if (destroyed) return;
        Arrays.fill(key, (byte) 0); Arrays.fill(patchedMoov, (byte) 0);
        for (Sample s : samples) s.wipe();
        samples.clear(); key = null; patchedMoov = null; destroyed = true;
    }
}
