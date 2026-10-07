package org.prismos.play;

import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import com.getcapacitor.JSObject;

final class PrismPlayerSurface implements AutoCloseable {
    final TextureView texture;
    private final WebView webView;
    private final ViewGroup parent;
    private final Drawable background;
    private final View.OnLayoutChangeListener layoutListener;
    private double left, top, width, height;

    PrismPlayerSurface(WebView webView, JSObject bounds) {
        validate(bounds);
        if (!(webView.getParent() instanceof ViewGroup)) throw new IllegalStateException();
        this.webView = webView;
        parent = (ViewGroup) webView.getParent();
        background = webView.getBackground();
        texture = new TextureView(webView.getContext());
        texture.setClickable(false);
        texture.setFocusable(false);
        layoutListener = (v, l, t, r, b, ol, ot, or, ob) -> layout();
        try {
            parent.addView(texture, 0, new ViewGroup.LayoutParams(1, 1));
            setBounds(bounds);
            webView.addOnLayoutChangeListener(layoutListener);
            webView.setBackgroundColor(Color.TRANSPARENT);
        } catch (RuntimeException error) {
            close();
            throw error;
        }
    }

    static void validate(JSObject bounds) {
        if (bounds == null) throw new IllegalArgumentException();
        for (String key : new String[]{"left", "top", "width", "height"}) {
            Object raw = bounds.opt(key);
            if (!(raw instanceof Number)) throw new IllegalArgumentException();
            double value = ((Number) raw).doubleValue();
            if (!Double.isFinite(value) || Math.abs(value) > 100000
                    || ((key.equals("width") || key.equals("height")) && value <= 0)) {
                throw new IllegalArgumentException();
            }
        }
    }

    void setBounds(JSObject bounds) {
        validate(bounds);
        left = bounds.optDouble("left"); top = bounds.optDouble("top");
        width = bounds.optDouble("width"); height = bounds.optDouble("height");
        layout();
    }

    private void layout() {
        float density = webView.getResources().getDisplayMetrics().density;
        ViewGroup.LayoutParams params = texture.getLayoutParams();
        params.width = Math.max(1, (int) Math.round(width * density));
        params.height = Math.max(1, (int) Math.round(height * density));
        texture.setLayoutParams(params);
        texture.setX(webView.getLeft() + (float) (left * density));
        texture.setY(webView.getTop() + (float) (top * density));
    }

    @Override public void close() {
        webView.removeOnLayoutChangeListener(layoutListener);
        parent.removeView(texture);
        webView.setBackground(background);
    }
}
