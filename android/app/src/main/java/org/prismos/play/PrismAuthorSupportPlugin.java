package org.prismos.play;

import android.app.Activity;
import android.content.Intent;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

@CapacitorPlugin(name = "PrismAuthorSupport")
public class PrismAuthorSupportPlugin extends Plugin {
    private byte[] pendingImage;

    @PluginMethod
    public void saveQr(PluginCall call) {
        String role = call.getString("role"), data = call.getString("data");
        if (!("contact".equals(role) || "reward".equals(role)) || data == null || data.length() > 1398104) {
            call.reject("二维码文件不可用"); return;
        }
        synchronized (this) {
            if (pendingImage != null) { call.reject("请先完成当前保存"); return; }
            try {
                byte[] image = Base64.decode(data, Base64.NO_WRAP);
                if (image.length < 3 || image.length > 1048576 || (image[0] & 255) != 255 || (image[1] & 255) != 216 || (image[2] & 255) != 255) {
                    call.reject("二维码图片格式不可用"); return;
                }
                pendingImage = image;
            } catch (IllegalArgumentException error) { call.reject("二维码图片格式不可用"); return; }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { saveToGallery(call, role); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("image/jpeg").putExtra(Intent.EXTRA_TITLE, "prism-play-author-" + role + ".jpg");
        try { startActivityForResult(call, intent, "saveResult"); }
        catch (RuntimeException error) { pendingImage = null; call.reject("无法打开系统保存窗口"); }
    }

    private void saveToGallery(PluginCall call, String role) {
        byte[] image;
        synchronized (this) { image = pendingImage; pendingImage = null; }
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "prism-play-author-" + role + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/PrismPlay");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = null;
        try {
            uri = getContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException();
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri)) {
                if (output == null) throw new IllegalStateException();
                output.write(image); output.flush();
            }
            values.clear(); values.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (getContext().getContentResolver().update(uri, values, null, null) != 1) throw new IllegalStateException();
            call.resolve(new JSObject().put("saved", true));
        } catch (Exception error) {
            if (uri != null) {
                try { getContext().getContentResolver().delete(uri, null, null); } catch (RuntimeException ignored) { }
            }
            call.reject("二维码图片保存失败");
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        byte[] image;
        synchronized (this) { image = pendingImage; pendingImage = null; }
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) { call.resolve(new JSObject().put("saved", false)); return; }
        if (image == null || result.getData() == null || result.getData().getData() == null) {
            call.reject("保存中断，请重新选择二维码"); return;
        }
        try (OutputStream output = getContext().getContentResolver().openOutputStream(result.getData().getData(), "wt")) {
            if (output == null) { call.reject("无法写入所选位置"); return; }
            output.write(image); output.flush();
        } catch (Exception error) { call.reject("二维码文件保存失败"); return; }
        call.resolve(new JSObject().put("saved", true));
    }

    @PluginMethod
    public void openWechat(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setPackage("com.tencent.mm").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(intent); call.resolve(); }
        catch (RuntimeException error) { call.reject("微信未安装或无法打开"); }
    }
}
