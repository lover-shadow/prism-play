package org.prismos.play;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

@UnstableApi
public final class PrismPlaybackProbeActivity extends Activity {
    private final Object deliveryLock = new Object();
    private final Handler main = new Handler(Looper.getMainLooper());
    private EditText videoId;
    private Button fetch;
    private TextView status;
    private PlayerView playerView;
    private ExoPlayer player;
    private ProbeCencDataSource.Factory dataSources;
    private ExecutorService executor;
    private ProbeNativeResolver resolver;
    private ProbeNativeResolver.Result playingResult;
    private ProbeNativeResolver.Result pendingResult;
    private boolean active;
    private int generation;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(16 * getResources().getDisplayMetrics().density);
        root.setPadding(padding, padding, padding, padding);
        root.setBackgroundResource(android.R.color.background_dark);
        TextView title = text("独立播放验证（非正式发布）");
        root.addView(title);
        root.addView(text("输入数字视频编号；默认编号仅作示例，不保证剧集身份。仅验证明确的高清兼容视频。"));
        videoId = new EditText(this);
        videoId.setInputType(InputType.TYPE_CLASS_NUMBER);
        videoId.setSingleLine(true);
        videoId.setHint("数字视频编号");
        videoId.setContentDescription("数字视频编号");
        videoId.setText("7671977930024553496");
        videoId.setSaveEnabled(false);
        root.addView(videoId, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        fetch = new Button(this);
        fetch.setText("获取并播放");
        fetch.setOnClickListener(view -> resolveAndPlay());
        root.addView(fetch);
        playerView = new PlayerView(this);
        playerView.setUseController(true);
        playerView.setContentDescription("视频播放器，可暂停和拖动进度");
        root.addView(playerView, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        status = text("等待验证。媒体地址与密钥仅在本次运行内存中使用。");
        root.addView(status);
        setContentView(root);
    }

    private TextView text(String value) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(getResources().getColor(android.R.color.primary_text_dark, getTheme()));
        return view;
    }

    @Override protected void onStart() {
        super.onStart();
        synchronized (deliveryLock) {
            active = true;
            generation++;
        }
        executor = Executors.newSingleThreadExecutor();
        fetch.setEnabled(true);
    }

    private void resolveAndPlay() {
        String id = videoId.getText().toString().trim();
        if (!id.matches("[0-9]{1,20}")) {
            status.setText("输入校验失败：请输入不超过二十位的数字编号。");
            return;
        }
        releasePlayer();
        final int requestGeneration;
        final ProbeNativeResolver requestResolver = new ProbeNativeResolver();
        synchronized (deliveryLock) {
            if (!active) { requestResolver.close(); return; }
            requestGeneration = ++generation;
            resolver = requestResolver;
        }
        fetch.setEnabled(false);
        status.setText("正在获取：请求签名、接口解析与高清元数据校验。");
        try {
            executor.execute(() -> resolveInBackground(id, requestGeneration, requestResolver));
        } catch (RejectedExecutionException rejected) {
            requestResolver.close();
            fetch.setEnabled(true);
            status.setText("任务启动失败，请重新进入验证页。");
        }
    }

    private void resolveInBackground(String id, int requestGeneration, ProbeNativeResolver requestResolver) {
        ProbeNativeResolver.Result result = null;
        String failure = null;
        try {
            result = requestResolver.resolve(id);
        } catch (ProbeNativeResolver.Failure error) {
            failure = error.stage;
        } catch (Exception error) {
            failure = "后台解析";
        } finally {
            requestResolver.close();
        }
        synchronized (deliveryLock) {
            if (!active || generation != requestGeneration) {
                if (result != null) result.close();
                return;
            }
            pendingResult = result;
            final String failedStage = failure;
            if (!main.post(() -> deliver(requestGeneration, failedStage))) {
                if (pendingResult != null) pendingResult.close();
                pendingResult = null;
            }
        }
    }

    private void deliver(int requestGeneration, String failedStage) {
        ProbeNativeResolver.Result result;
        synchronized (deliveryLock) {
            if (!active || generation != requestGeneration) return;
            if (isFinishing() || isDestroyed()) {
                if (pendingResult != null) pendingResult.close();
                pendingResult = null;
                return;
            }
            result = pendingResult;
            pendingResult = null;
            resolver = null;
        }
        fetch.setEnabled(true);
        if (result == null) {
            status.setText((failedStage == null ? "响应解析" : failedStage) + "阶段失败，请重试。");
            return;
        }
        playingResult = result;
        try {
            dataSources = new ProbeCencDataSource.Factory(result.url, result.key);
            DefaultMediaSourceFactory sources = new DefaultMediaSourceFactory(this)
                .setDataSourceFactory(dataSources);
            player = new ExoPlayer.Builder(this).setMediaSourceFactory(sources).build();
            player.addListener(new Player.Listener() {
                @Override public void onPlaybackStateChanged(int state) {
                    if (state == Player.STATE_READY) status.setText("播放就绪：高清兼容视频，可暂停与拖动进度。");
                    else if (state == Player.STATE_BUFFERING) status.setText("正在加载媒体与解密数据。");
                    else if (state == Player.STATE_ENDED) status.setText("本次验证播放结束，可拖动进度重新验证。");
                }
                @Override public void onPlayerError(PlaybackException error) {
                    status.setText("播放失败（" + error.getErrorCodeName()
                        + "），请把此页面截图反馈，以便定位读取、解密或解码阶段。");
                    releasePlayer();
                }
            });
            playerView.setPlayer(player);
            player.setMediaItem(new MediaItem.Builder().setUri(result.url)
                .setMimeType("video/mp4").build());
            status.setText("解析完成：运行时密钥已就绪，时长约 " + Math.round(result.duration) + " 秒。");
            player.prepare();
            player.play();
        } catch (Exception error) {
            releasePlayer();
            status.setText("播放器初始化阶段失败，请检查验证依赖后重试。");
        }
    }

    private void releasePlayer() {
        playerView.setPlayer(null);
        if (player != null) {
            player.release();
            player = null;
        }
        if (dataSources != null) {
            dataSources.destroy();
            dataSources = null;
        }
        if (playingResult != null) {
            playingResult.close();
            playingResult = null;
        }
    }

    private void stopSession() {
        synchronized (deliveryLock) {
            active = false;
            generation++;
            if (resolver != null) { resolver.close(); resolver = null; }
            if (pendingResult != null) { pendingResult.close(); pendingResult = null; }
            main.removeCallbacksAndMessages(null);
        }
        if (executor != null) { executor.shutdownNow(); executor = null; }
        releasePlayer();
    }

    @Override protected void onPause() {
        if (player != null) player.pause();
        super.onPause();
    }

    @Override protected void onStop() {
        stopSession();
        status.setText("验证已停止，播放资源和运行时密钥已清理；返回后请重新获取。");
        super.onStop();
    }

    @Override protected void onDestroy() {
        stopSession();
        super.onDestroy();
    }
}
