package org.prismos.play;

import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

final class ProbeNativeResolver implements AutoCloseable {
    private static final String BASE = "https://api5-normal-sinfonlineb.fqnovel.com";
    private static final String UA = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
    private static final int MAX_RESPONSE = 4 * 1024 * 1024;
    private HttpURLConnection connection;
    private volatile boolean closed;

    static final class Result implements AutoCloseable {
        String url;
        final byte[] key;
        final double duration;

        Result(String url, byte[] key, double duration) {
            this.url = url;
            this.key = key;
            this.duration = duration;
        }

        @Override public void close() {
            Arrays.fill(key, (byte) 0);
            url = null;
        }
    }

    static final class Failure extends Exception {
        final String stage;
        Failure(String stage) { super(stage); this.stage = stage; }
    }

    Result resolve(String videoId) throws Failure {
        if (videoId == null || !videoId.matches("[0-9]{1,32}")) throw new Failure("输入校验");
        String stage = "请求签名";
        try {
            long now = System.currentTimeMillis();
            String query = query(now);
            byte[] body = ("{\"video_id\":\"" + videoId + "\",\"content_type\":1,"
                + "\"biz_param\":{\"need_all_video_definition\":true,\"video_platform\":3}}")
                .getBytes(StandardCharsets.UTF_8);
            Map<String, String> headers = ProbeRequestSigner.sign(query, body, now);
            stage = "接口请求";
            String text = request(query, body, headers);
            checkOpen();
            stage = "响应解析";
            JSONObject response = new JSONObject(text);
            JSONObject data = response.getJSONObject("data");
            Object rawModel = data.get("video_model");
            JSONObject model = rawModel instanceof String ? new JSONObject((String) rawModel)
                : (JSONObject) rawModel;
            double duration = model.optDouble("video_duration", model.optDouble("duration", Double.NaN));
            if (Double.isNaN(duration) || Double.isInfinite(duration) || duration <= 0) {
                throw new Failure("时长元数据校验");
            }
            Object rawList = model.get("video_list");
            JSONArray variants;
            if (rawList instanceof JSONArray) variants = (JSONArray) rawList;
            else if (rawList instanceof JSONObject) {
                variants = new JSONArray();
                JSONObject list = (JSONObject) rawList;
                Iterator<String> names = list.keys();
                while (names.hasNext()) variants.put(list.get(names.next()));
            } else throw new Failure("视频元数据校验");
            String rejection = "未找到明确的高清兼容视频";
            for (int i = 0; i < variants.length(); i++) {
                checkOpen();
                JSONObject variant = variants.optJSONObject(i);
                if (variant == null) continue;
                JSONObject meta = variant.optJSONObject("video_meta");
                if (meta == null) { rejection = "视频元数据校验"; continue; }
                String codec = meta.optString("codec_type", "").toLowerCase(Locale.ROOT);
                if (!(codec.equals("bytevc1") || codec.equals("hevc") || codec.equals("hvc1")
                    || codec.equals("hev1"))) continue;
                double height = meta.optDouble("vheight", meta.optDouble("height", Double.NaN));
                double width = meta.optDouble("vwidth", meta.optDouble("width", Double.NaN));
                String definition = variant.optString("definition", meta.optString("definition", ""));
                if (!(Math.min(width, height) >= 1080 && Double.isFinite(width) && Double.isFinite(height))
                    && !definition.equalsIgnoreCase("1080p")) {
                    rejection = "清晰度元数据校验";
                    continue;
                }
                JSONObject encryption = variant.optJSONObject("encrypt_info");
                if (encryption == null) { rejection = "运行时密钥解析"; continue; }
                byte[] key;
                try { key = ProbeSpadeKey.extract(encryption.optString("spade_a", "")); }
                catch (Exception invalidKey) { rejection = "运行时密钥解析"; continue; }
                try {
                    for (String field : new String[]{"main_url", "backup_url", "backup_url_1",
                        "backup_url_2", "backup_urls", "url_list"}) {
                        String url = address(variant.opt(field));
                        if (url != null) {
                            checkOpen();
                            return new Result(url, key, duration);
                        }
                    }
                    rejection = "媒体地址安全校验（白名单外域名需审核）";
                } catch (Exception error) {
                    Arrays.fill(key, (byte) 0);
                    throw error;
                }
                Arrays.fill(key, (byte) 0);
            }
            throw new Failure(rejection);
        } catch (Failure failure) {
            throw failure;
        } catch (Exception failure) {
            throw new Failure(stage);
        }
    }

    static String checkedMediaUrl(String value) throws Exception {
        if (value == null || value.length() > 8192) throw new Exception("Invalid media address");
        URI uri = new URI(value);
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null
            || host == null || uri.getFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) {
            throw new Exception("Invalid media address");
        }
        host = host.toLowerCase(Locale.ROOT);
        if (!host.endsWith(".qznovelvod.com") || host.length() <= ".qznovelvod.com".length()) {
            throw new Exception("Media host not allowed");
        }
        for (String label : host.split("\\.", -1)) {
            if (!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
                throw new Exception("Invalid media host");
            }
        }
        return uri.toASCIIString();
    }

    private static String address(Object value) {
        if (value instanceof JSONArray) {
            JSONArray list = (JSONArray) value;
            for (int i = 0; i < list.length(); i++) {
                String found = address(list.opt(i));
                if (found != null) return found;
            }
            return null;
        }
        if (!(value instanceof String)) return null;
        String candidate = ((String) value).trim();
        if (candidate.isEmpty() || candidate.length() > 8192) return null;
        try {
            if (!candidate.startsWith("https://") && !candidate.startsWith("http://")) {
                candidate = new String(Base64.decode(candidate, Base64.DEFAULT), StandardCharsets.UTF_8).trim();
            }
            return checkedMediaUrl(candidate);
        } catch (Exception rejected) { return null; }
    }

    private String request(String query, byte[] body, Map<String, String> headers) throws Exception {
        HttpURLConnection current = (HttpURLConnection) new URL(BASE
            + "/novel/player/video_model/v1/?" + query).openConnection();
        synchronized (this) {
            if (closed) { current.disconnect(); throw new Failure("请求已取消"); }
            connection = current;
        }
        try {
            current.setConnectTimeout(15000);
            current.setReadTimeout(20000);
            current.setInstanceFollowRedirects(false);
            current.setUseCaches(false);
            current.setRequestMethod("POST");
            current.setDoOutput(true);
            current.setFixedLengthStreamingMode(body.length);
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                current.setRequestProperty(entry.getKey(), entry.getValue());
            }
            current.setRequestProperty("User-Agent", UA);
            current.setRequestProperty("Referer", "https://novel.snssdk.com/");
            current.setRequestProperty("Accept", "application/json");
            current.setRequestProperty("Accept-Encoding", "identity");
            current.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            current.setRequestProperty("X-XS-From-Web", "0");
            current.setRequestProperty("Sdk-Version", "2");
            try (OutputStream output = current.getOutputStream()) { output.write(body); }
            if (current.getResponseCode() != 200) throw new Failure("接口响应校验");
            if (current.getContentLengthLong() > MAX_RESPONSE) throw new Failure("响应大小校验");
            try (InputStream input = current.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                int total = 0;
                while ((count = input.read(buffer)) != -1) {
                    checkOpen();
                    total += count;
                    if (total > MAX_RESPONSE) throw new Failure("响应大小校验");
                    output.write(buffer, 0, count);
                }
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            current.disconnect();
            synchronized (this) { if (connection == current) connection = null; }
        }
    }

    private static String query(long now) throws Exception {
        String[][] params = {
            {"aid", "8662"}, {"app_name", "novelread"}, {"version_code", "73532"},
            {"version_name", "7.3.5.32"}, {"manifest_version_code", "73532"},
            {"update_version_code", "73532"}, {"channel", "update_64"},
            {"device_platform", "android"}, {"os", "android"}, {"ssmix", "a"},
            {"device_type", "25053RT47C"}, {"device_brand", "Redmi"}, {"language", "zh"},
            {"os_api", "36"}, {"os_version", "16"}, {"resolution", "1280*2772"},
            {"dpi", "520"}, {"ac", "wifi"}, {"device_id", ProbeRequestSigner.deviceId()},
            {"iid", ProbeRequestSigner.deviceId()}, {"_rticket", Long.toString(now)}
        };
        StringBuilder query = new StringBuilder();
        for (String[] param : params) {
            if (query.length() > 0) query.append('&');
            query.append(URLEncoder.encode(param[0], "UTF-8")).append('=')
                .append(URLEncoder.encode(param[1], "UTF-8"));
        }
        return query.toString();
    }

    private void checkOpen() throws Failure {
        if (closed || Thread.currentThread().isInterrupted()) throw new Failure("请求已取消");
    }

    @Override public synchronized void close() {
        closed = true;
        if (connection != null) { connection.disconnect(); connection = null; }
    }
}
