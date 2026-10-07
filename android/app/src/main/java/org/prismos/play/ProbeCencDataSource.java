package org.prismos.play;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ProbeCencDataSource extends BaseDataSource {
    private static final Pattern RANGE = Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)");
    private final String target;
    private final byte[] key;
    private CencMp4Index index;
    private HttpURLConnection connection;
    private InputStream stream;
    private long position;
    private long remaining;
    private Uri uri;
    private boolean opened;
    private long resourceLength = -1;
    private String resourceTag;

    public static final class Factory implements DataSource.Factory {
        private final String target;
        private final byte[] key;
        private final java.util.List<ProbeCencDataSource> sources = new java.util.ArrayList<>();
        public Factory(String target, byte[] key) {
            this.target = target;
            this.key = key.clone();
        }
        @Override public synchronized DataSource createDataSource() {
            ProbeCencDataSource source = new ProbeCencDataSource(target, key);
            sources.add(source);
            return source;
        }
        public synchronized void destroy() {
            Arrays.fill(key, (byte) 0);
            for (ProbeCencDataSource source : sources) {
                try { source.destroy(); } catch (IOException ignored) { }
            }
            sources.clear();
        }
    }

    public ProbeCencDataSource(String target, byte[] key) {
        super(true);
        this.target = target;
        this.key = key.clone();
    }

    private HttpURLConnection request(long start, long end) throws IOException {
        URI parsed;
        try { parsed = URI.create(target); }
        catch (IllegalArgumentException error) { throw new IOException("Invalid media target"); }
        String host = parsed.getHost();
        if (!"https".equals(parsed.getScheme()) || host == null || parsed.getUserInfo() != null
                || parsed.getPort() != -1 || !host.endsWith(".qznovelvod.com")) {
            throw new IOException("Media target not allowed");
        }
        HttpURLConnection result = (HttpURLConnection) parsed.toURL().openConnection();
        result.setInstanceFollowRedirects(false);
        result.setConnectTimeout(15000);
        result.setReadTimeout(20000);
        result.setRequestProperty("Accept-Encoding", "identity");
        result.setRequestProperty("Range", "bytes=" + start + "-" + (end < 0 ? "" : end));
        result.setRequestProperty("User-Agent", "PrismPlay-Playback-Probe");
        try {
            if (result.getResponseCode() != 206) throw new IOException("Media range rejected");
            String encoding = result.getHeaderField("Content-Encoding");
            if (encoding != null && !"identity".equalsIgnoreCase(encoding)) {
                throw new IOException("Compressed range not supported");
            }
            Matcher range = RANGE.matcher(String.valueOf(result.getHeaderField("Content-Range")));
            if (!range.matches()) throw new IOException("Invalid media range");
            long actualStart = Long.parseLong(range.group(1));
            long actualEnd = Long.parseLong(range.group(2));
            long total = Long.parseLong(range.group(3));
            if (actualStart != start || actualEnd < start || actualEnd >= total
                    || (end >= 0 && actualEnd != Math.min(end, total - 1))) {
                throw new IOException("Mismatched media range");
            }
            String tag = result.getHeaderField("ETag");
            if (resourceLength >= 0 && (resourceLength != total
                    || (resourceTag != null && !resourceTag.equals(tag)))) {
                throw new IOException("Media resource changed");
            }
            resourceLength = total;
            resourceTag = tag;
            return result;
        } catch (IOException | RuntimeException error) {
            result.disconnect();
            throw new IOException("Media range failed", error);
        }
    }

    private byte[] fetch(long start, int length) throws IOException {
        HttpURLConnection request = request(start, Math.addExact(start, length - 1L));
        try (InputStream input = request.getInputStream()) {
            byte[] result = new byte[length];
            int consumed = 0;
            while (consumed < length) {
                int count = input.read(result, consumed, length - consumed);
                if (count < 0) throw new IOException("Truncated media metadata");
                if (count > 0) consumed += count;
            }
            return result;
        } finally { request.disconnect(); }
    }

    private void initialize() throws IOException {
        long offset = 0;
        for (int count = 0; count < 64; count++) {
            byte[] header = fetch(offset, 16);
            ByteBuffer bytes = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN);
            long size = Integer.toUnsignedLong(bytes.getInt());
            int type = bytes.getInt();
            int headerSize = 8;
            if (size == 1) { size = bytes.getLong(); headerSize = 16; }
            if (size < headerSize) throw new IOException("Unsupported MP4 box size");
            if (type == 0x6d6f6f66) throw new IOException("Fragmented MP4 not supported by probe");
            if (type == 0x6d6f6f76) {
                if (size > 33554432) throw new IOException("MP4 metadata too large");
                byte[] moov = fetch(offset, (int) size);
                index = CencMp4Index.parse(moov, offset, key);
                Arrays.fill(key, (byte) 0);
                if (index.sampleCount() == 0) throw new IOException("No encrypted samples");
                return;
            }
            try { offset = Math.addExact(offset, size); }
            catch (ArithmeticException error) { throw new IOException("Invalid MP4 offset"); }
        }
        throw new IOException("MP4 metadata not found");
    }

    @Override public long open(DataSpec spec) throws IOException {
        transferInitializing(spec);
        try {
            if (index == null) initialize();
            position = spec.position;
            long end = spec.length == C.LENGTH_UNSET ? -1 : Math.addExact(position, spec.length - 1);
            connection = request(position, end);
            Matcher range = RANGE.matcher(connection.getHeaderField("Content-Range"));
            if (!range.matches()) throw new IOException("Invalid media range");
            remaining = Long.parseLong(range.group(2)) - position + 1;
            stream = connection.getInputStream();
            uri = spec.uri;
            opened = true;
            transferStarted(spec);
            return remaining;
        } catch (IOException | RuntimeException error) {
            close();
            throw new IOException("Unable to open encrypted media", error);
        }
    }

    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        if (remaining == 0) return C.RESULT_END_OF_INPUT;
        if (stream == null || index == null) throw new IOException("Media source is closed");
        int count = stream.read(buffer, offset, (int) Math.min(length, remaining));
        if (count < 0) throw new IOException("Truncated media stream");
        index.decrypt(buffer, offset, count, position);
        position += count;
        remaining -= count;
        bytesTransferred(count);
        return count;
    }

    @Override public Uri getUri() { return uri; }

    @Override public void close() throws IOException {
        try { if (stream != null) stream.close(); }
        finally {
            stream = null;
            if (connection != null) connection.disconnect();
            connection = null;
            uri = null;
            if (opened) { opened = false; transferEnded(); }
        }
    }

    public void destroy() throws IOException {
        try { close(); }
        finally {
            Arrays.fill(key, (byte) 0);
            if (index != null) index.destroy();
            index = null;
        }
    }
}
