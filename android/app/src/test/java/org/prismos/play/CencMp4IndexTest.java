package org.prismos.play;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Arrays;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.prismos.play.CencFixture.*;

public class CencMp4IndexTest {
    @Test public void wholeSamplesBothIvSizes() throws Exception {
        for (int ivSize : new int[]{8, 16}) {
            byte[] p = plain(67);
            CencMp4Index index = CencMp4Index.parse(box("moov", track(false, ivSize, 4096, p.length, null)), 20, KEY);
            byte[] encrypted = encrypt(p, ivSize, null);
            index.decrypt(encrypted, 0, encrypted.length, 4096);
            assertArrayEquals(p, encrypted);
            assertEquals(1, index.sampleCount());
        }
    }
    @Test public void audioVideoAndLargeAbsoluteOffsets() throws Exception {
        long start = 5000000000L;
        byte[] moov = box("moov", track(false, 8, start, 41, null), track(true, 16, start + 41, 29, null));
        CencMp4Index index = CencMp4Index.parse(moov, 0, KEY);
        byte[] data = join(encrypt(plain(41), 8, null), encrypt(plain(29), 16, null));
        index.decrypt(data, 0, data.length, start);
        assertArrayEquals(join(plain(41), plain(29)), data);
        assertEquals(2, index.sampleCount());
    }
    @Test public void subsampleClearBytesDoNotAdvanceCtr() throws Exception {
        int[][] subs = {{5, 7}, {11, 23}, {2, 19}};
        byte[] p = plain(67);
        CencMp4Index index = CencMp4Index.parse(box("moov", track(false, 16, 4096, 67, subs)), 0, KEY);
        byte[] encrypted = encrypt(p, 16, subs);
        index.decrypt(encrypted, 0, 67, 4096);
        assertArrayEquals(p, encrypted);
    }
    @Test public void arbitraryRangesAndBufferOffsets() throws Exception {
        int[][] subs = {{3, 19}, {7, 38}};
        byte[] p = plain(67), encrypted = encrypt(p, 8, subs);
        CencMp4Index index = CencMp4Index.parse(box("moov", track(false, 8, 4096, 67, subs)), 0, KEY);
        for (int start = 0; start < 67; start++) {
            for (int n = 1; n <= 67 - start; n++) {
                byte[] range = new byte[n + 4];
                Arrays.fill(range, (byte) 99);
                System.arraycopy(encrypted, start, range, 2, n);
                index.decrypt(range, 2, n, 4096 + start);
                assertArrayEquals(Arrays.copyOfRange(p, start, start + n), Arrays.copyOfRange(range, 2, n + 2));
                assertEquals(99, range[0]);
                assertEquals(99, range[n + 3]);
            }
        }
    }
    @Test public void patchesMoovWithoutChangingLengthsOrInput() throws Exception {
        byte[] moov = box("moov", track(false, 8, 4096, 32, null), track(true, 8, 4128, 32, null));
        byte[] original = moov.clone();
        CencMp4Index index = CencMp4Index.parse(moov, 100, KEY);
        byte[] patched = moov.clone();
        index.decrypt(patched, 0, patched.length, 100);
        assertArrayEquals(original, moov);
        assertEquals(moov.length, patched.length);
        assertTrue(find(patched, "avc1") > 0);
        assertTrue(find(patched, "mp4a") > 0);
        for (String type : new String[]{"sinf", "senc", "saiz", "saio"}) {
            int at = find(original, type);
            assertArrayEquals(text("free"), Arrays.copyOfRange(patched, at, at + 4));
            byte[] partial = new byte[3];
            index.decrypt(partial, 0, 3, 100 + at + 1);
            assertArrayEquals(text("ree"), partial);
        }
    }
    @Test public void rejectsEveryTruncatedPrefix() throws Exception {
        byte[] moov = box("moov", track(false, 8, 4096, 32, null));
        for (int n = 0; n < moov.length; n++) {
            final byte[] truncated = Arrays.copyOf(moov, n);
            assertThrows(IOException.class, () -> CencMp4Index.parse(truncated, 0, KEY));
        }
    }
    @Test public void rejectsUnsupportedAndInvalidTables() throws Exception {
        byte[] good = box("moov", track(false, 8, 4096, 32, null));
        for (String type : new String[]{"senc", "tenc", "stsc", "stsz", "stco", "frma"}) {
            byte[] bad = good.clone();
            System.arraycopy(text("free"), 0, bad, find(bad, type), 4);
            assertThrows(type, IOException.class, () -> CencMp4Index.parse(bad, 0, KEY));
        }
        byte[] constant = good.clone();
        constant[find(constant, "tenc") + 11] = 0;
        assertThrows(IOException.class, () -> CencMp4Index.parse(constant, 0, KEY));
        byte[] override = good.clone();
        override[find(override, "senc") + 7] = 1;
        assertThrows(IOException.class, () -> CencMp4Index.parse(override, 0, KEY));
        assertThrows(IOException.class, () -> CencMp4Index.parse(box("moov", box("mvex"), track(false, 8, 4096, 32, null)), 0, KEY));
        assertThrows(IOException.class, () -> CencMp4Index.parse(box("moov", track(false, 8, 4096, 32, null), track(true, 8, 4097, 32, null)), 0, KEY));
        byte[] count = good.clone();
        ByteBuffer.wrap(count).putInt(find(count, "stsz") + 12, Integer.MAX_VALUE);
        assertThrows(IOException.class, () -> CencMp4Index.parse(count, 0, KEY));
    }
    @Test public void variableSizesAndChunkMapping() throws Exception {
        CencMp4Index index = CencMp4Index.parse(box("moov", multiSampleTrack()), 0, KEY);
        assertEquals(3, index.sampleCount());
        byte[] data = new byte[5031 - 4096];
        Arrays.fill(data, (byte) 77);
        byte[] first = encrypt(plain(17), 8, null), second = encrypt(plain(23), 8, null);
        System.arraycopy(first, 0, data, 0, 17);
        System.arraycopy(second, 0, data, 17, 23);
        System.arraycopy(encrypt(plain(31), 8, null), 0, data, 5000 - 4096, 31);
        index.decrypt(data, 0, data.length, 4096);
        assertArrayEquals(join(plain(17), plain(23)), Arrays.copyOf(data, 40));
        assertArrayEquals(plain(31), Arrays.copyOfRange(data, 904, 935));
        assertEquals(77, data[500]);
    }
    @Test public void rejectsMalformedBoxSizesAndTableCounts() throws Exception {
        byte[] good = box("moov", track(false, 8, 4096, 32, null));
        for (String type : new String[]{"trak", "mdia", "minf", "stbl", "stsd", "sinf", "tenc"}) {
            for (int size : new int[]{7, Integer.MAX_VALUE}) {
                byte[] bad = good.clone();
                ByteBuffer.wrap(bad).putInt(find(bad, type) - 4, size);
                assertThrows(IOException.class, () -> CencMp4Index.parse(bad, 0, KEY));
            }
        }
        for (String type : new String[]{"stsd", "stsc", "stco", "senc", "saio"}) {
            byte[] bad = good.clone();
            ByteBuffer.wrap(bad).putInt(find(bad, type) + 8, Integer.MAX_VALUE);
            assertThrows(IOException.class, () -> CencMp4Index.parse(bad, 0, KEY));
        }
        byte[] unsupported = good.clone();
        System.arraycopy(text("cbcs"), 0, unsupported, find(unsupported, "schm") + 8, 4);
        assertThrows(IOException.class, () -> CencMp4Index.parse(unsupported, 0, KEY));
        byte[] audio = track(true, 8, 4128, 32, null);
        audio[find(audio, "tenc") + 12] = 7;
        byte[] rotated = box("moov", track(false, 8, 4096, 32, null), audio);
        assertThrows(IOException.class, () -> CencMp4Index.parse(rotated, 0, KEY));
    }
    @Test public void rejectsSubsampleAndAuxiliaryMismatch() throws Exception {
        byte[] bad = box("moov", track(false, 8, 4096, 32, new int[][]{{3, 28}}));
        assertThrows(IOException.class, () -> CencMp4Index.parse(bad, 0, KEY));
        byte[] size = box("moov", track(false, 8, 4096, 32, null));
        size[find(size, "saiz") + 8] = 9;
        assertThrows(IOException.class, () -> CencMp4Index.parse(size, 0, KEY));
    }
    @Test public void counterCarryAndCallerKeyOwnership() throws Exception {
        byte[] moov = box("moov", track(false, 16, 4096, 67, null));
        int ivAt = find(moov, "senc") + 12;
        byte[] iv = new byte[16];
        Arrays.fill(iv, 8, 16, (byte) 255);
        System.arraycopy(iv, 0, moov, ivAt, 16);
        byte[] callerKey = KEY.clone();
        CencMp4Index index = CencMp4Index.parse(moov, 0, callerKey);
        callerKey[0] = 55;
        javax.crypto.Cipher ctr = javax.crypto.Cipher.getInstance("AES/CTR/NoPadding");
        ctr.init(javax.crypto.Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(KEY, "AES"),
                new javax.crypto.spec.IvParameterSpec(iv));
        byte[] encrypted = ctr.doFinal(plain(67));
        byte[] range = Arrays.copyOfRange(encrypted, 19, 61);
        index.decrypt(range, 0, range.length, 4115);
        assertArrayEquals(Arrays.copyOfRange(plain(67), 19, 61), range);
        index.destroy();
        assertEquals(55, callerKey[0]);
    }
    @Test public void validatesRangeAndDestroy() throws Exception {
        byte[] moov = box("moov", track(false, 8, 4096, 32, null));
        assertThrows(IOException.class, () -> CencMp4Index.parse(moov, Long.MAX_VALUE, KEY));
        assertThrows(IOException.class, () -> CencMp4Index.parse(moov, 0, new byte[15]));
        CencMp4Index index = CencMp4Index.parse(moov, 0, KEY);
        assertThrows(IOException.class, () -> index.decrypt(new byte[4], 3, 2, 0));
        assertThrows(IOException.class, () -> index.decrypt(new byte[4], 0, 4, Long.MAX_VALUE));
        index.destroy();
        index.destroy();
        assertEquals(0, index.sampleCount());
        assertThrows(IOException.class, () -> index.decrypt(new byte[32], 0, 32, 4096));
    }
}
