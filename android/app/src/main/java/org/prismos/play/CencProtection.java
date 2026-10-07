package org.prismos.play;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import static org.prismos.play.CencBoxes.*;

final class CencProtection {
    final int ivSize, descriptions;
    final byte[] kid;
    CencProtection(int ivSize, int descriptions, byte[] kid) {
        this.ivSize = ivSize; this.descriptions = descriptions; this.kid = kid;
    }
    static CencProtection parse(byte[] b, Box stsd) throws IOException {
        full(b, stsd, 0, 0);
        int n = count(b, stsd.payload + 4, stsd.end, 8);
        check(n > 0, "Empty stsd");
        int pos = stsd.payload + 8;
        CencProtection result = null;
        boolean clear = false;
        for (int i = 0; i < n; i++) {
            Box entry = box(b, pos, stsd.end);
            boolean audio = entry.type.equals("enca");
            if (audio || entry.type.equals("encv")) {
                need(entry.payload, audio ? 28 : 78, entry.end);
                if (audio) check(b[entry.payload + 8] == 0 && b[entry.payload + 9] == 0,
                        "Unsupported audio sample entry version");
                List<Box> children = children(b, entry.payload + (audio ? 28 : 78), entry.end);
                Box sinf = find(children, "sinf", true);
                CencProtection p = sinf(b, sinf, n);
                check(!clear, "Mixed clear/encrypted descriptions unsupported");
                if (result != null) check(result.ivSize == p.ivSize && Arrays.equals(result.kid, p.kid),
                        "Key/IV rotation unsupported");
                result = p;
                Box frma = find(inside(b, sinf), "frma", true);
                String format = type(b, frma.payload);
                check(!format.equals("encv") && !format.equals("enca") && !format.equals("free"),
                        "Invalid original sample format");
                rename(b, entry, format);
                rename(b, sinf, "free");
            } else {
                check(result == null, "Mixed clear/encrypted descriptions unsupported");
                clear = true;
            }
            pos = entry.end;
        }
        finish(pos, stsd);
        return result == null ? new CencProtection(0, n, null) : result;
    }
    private static CencProtection sinf(byte[] b, Box sinf, int descriptions) throws IOException {
        List<Box> boxes = inside(b, sinf);
        Box frma = find(boxes, "frma", true);
        need(frma.payload, 4, frma.end); finish(frma.payload + 4, frma);
        Box schm = find(boxes, "schm", true);
        full(b, schm, 0, 0);
        need(schm.payload, 12, schm.end); finish(schm.payload + 12, schm);
        check(type(b, schm.payload + 4).equals("cenc"), "Only cenc AES-CTR supported");
        Box schi = find(boxes, "schi", true);
        Box tenc = find(inside(b, schi), "tenc", true);
        need(tenc.payload, 24, tenc.end);
        int version = b[tenc.payload] & 255;
        check(version <= 1, "Unsupported tenc version");
        full(b, tenc, version, 0);
        check(b[tenc.payload + 4] == 0 && b[tenc.payload + 5] == 0,
                "Pattern encryption unsupported");
        check((b[tenc.payload + 6] & 255) == 1, "Invalid tenc protection flag");
        int iv = b[tenc.payload + 7] & 255;
        check(iv != 0, "Constant IV unsupported");
        check(iv == 8 || iv == 16, "tenc IV must be 8 or 16 bytes");
        finish(tenc.payload + 24, tenc);
        return new CencProtection(iv, descriptions, Arrays.copyOfRange(b, tenc.payload + 8, tenc.end));
    }
    static void rejectRotation(byte[] b, List<Box> boxes) throws IOException {
        for (Box box : boxes) {
            check(!box.type.equals("uuid"), "UUID encryption metadata unsupported");
            if (box.type.equals("sbgp") || box.type.equals("sgpd")) {
                need(box.payload, 8, box.end);
                check(!type(b, box.payload + 4).equals("seig"), "Sample encryption key rotation unsupported");
            }
        }
    }
    private CencProtection() { ivSize = 0; descriptions = 0; kid = null; }
}
