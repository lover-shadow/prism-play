package org.prismos.play;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.Nullable;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.Logger;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.regex.Pattern;

/**
 * Storage Domain 1 of SPEC 6.1: the only place an Ed25519 JWT or the install device id may touch disk.
 *
 * The file is an EncryptedSharedPreferences instance whose data key is wrapped by an AndroidKeyStore
 * MasterKey, so the plaintext never leaves the process and the wrapping key is marked
 * NonExportable. ARCHITECTURE Layer 3 forbids a plaintext preferences file for credentials, and that
 * prohibition is why this class FAILS CLOSED: if the master key or the encrypted file cannot be
 * created, no fallback to ordinary SharedPreferences is attempted. isKeystoreBacked() reports false,
 * every write is rejected with KEYSTORE_UNAVAILABLE, and the TypeScript side is required to say
 * "硬件密钥不可用" instead of pretending the user is authorized on a store it cannot trust.
 *
 * BACKUP EXCLUSION IS A HARD REQUIREMENT, NOT A TIDINESS PREFERENCE (Master decision M-8): the
 * master key material is bound to this device and cannot migrate. If Android's auto backup copied
 * shared_prefs/{@value #PREFS_FILE}.xml to Google One and restored it on a new phone, the ciphertext
 * would be undecryptable there and the restored install would look permanently unauthorized -
 * strictly worse than having backed nothing up. The exclusion is realised by name in
 * res/xml/data_extraction_rules.xml and res/xml/backup_rules.xml, which whitelist ONLY
 * CapacitorStorage.xml (preferences) plus the watch-history database; PREFS_FILE below must stay
 * byte-identical to those two XMLs or the guarantee silently rots. androidx.security may also create
 * a master-key metadata file (commonly __androidx_security_master_key_.xml, excluded as well); the
 * whitelist formulation is what makes an unexpected extra filename harmless - confirm the real list
 * on a device with "adb shell run-as org.prismos.play ls -l shared_prefs".
 *
 * DEPRECATION NOTICE, DELIBERATELY KEPT VISIBLE: androidx.security:security-crypto 1.1.0 (last
 * release, 2025-07-30) is deprecated upstream in favour of using AndroidKeyStore directly. It is used
 * here because the Stage 3 brief mandates MasterKey + EncryptedSharedPreferences. Blast radius is one
 * class: replacing it with a hand-rolled Keystore AES-GCM envelope over a private file changes only
 * this file and the PREFS_FILE name in the two backup rule XMLs.
 */
final class SecureCredentialStore {

    /** SharedPreferences file name; mirrored in data_extraction_rules.xml and backup_rules.xml. */
    static final String PREFS_FILE = "prism_credentials_encrypted";

    static final String CODE_UNAVAILABLE = "KEYSTORE_UNAVAILABLE";
    static final String CODE_BAD_KEY = "CREDENTIAL_KEY_INVALID";
    static final String CODE_BAD_VALUE = "CREDENTIAL_VALUE_INVALID";
    static final String CODE_PRIVATE_SESSION_KEY = "PRIVATE_SESSION_NOT_STOREABLE";

    /** Namespaced lower-case key, e.g. "jwt", "deviceId", "redeem.lastTier". */
    private static final Pattern KEY_SHAPE = Pattern.compile("^[a-z][a-z0-9_.-]{1,63}$");

    /** Three base64url segments: the shape of the Ed25519 JWT the edge signs (SPEC 4, kid p2026). */
    private static final Pattern JWT_SHAPE =
            Pattern.compile("^[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}$");

    /** Device id as defined by the contract: "GY-" plus eight upper-case alphanumeric characters. */
    private static final Pattern DEVICE_ID_SHAPE = Pattern.compile("^GY-[A-Z0-9]{8}$");

    /** A credential store is not a general-purpose KV: cap the payload so nothing else creeps in. */
    private static final int MAX_VALUE_LENGTH = 4096;

    /**
     * AC-02 forbids persisting the private opt-in credential, in ANY form. Refusing these key names
     * is what stops a future caller from "just using the secure store" for a session token, which
     * would put 个人探索 on disk and break the 双层隐形 promise. The session token belongs to
     * VolatileStore in src/core/storage/storage-domains.ts and to nowhere else.
     */
    private static final Pattern RESERVED_SESSION_KEY =
            Pattern.compile(".*(private[-_.]?session|session[-_.]?token).*", Pattern.CASE_INSENSITIVE);

    @Nullable
    private final SharedPreferences prefs;

    private final boolean keystoreBacked;

    private SecureCredentialStore(@Nullable SharedPreferences prefs, boolean keystoreBacked) {
        this.prefs = prefs;
        this.keystoreBacked = keystoreBacked;
    }

    /**
     * Opens (creating on first use) the encrypted store. Never throws: an unavailable Keystore is a
     * reported capability state, not a crash, because the app still has to render public channels.
     */
    static SecureCredentialStore open(Context context) {
        try {
            MasterKey masterKey = new MasterKey.Builder(context.getApplicationContext())
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            SharedPreferences encrypted = EncryptedSharedPreferences.create(
                    context.getApplicationContext(),
                    PREFS_FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
            if (!masterKeyAliasResolvable(masterKey.getAlias())) {
                Logger.warn(Logger.tags("PrismSecureStore"), "master key alias not resolvable in AndroidKeyStore");
                return new SecureCredentialStore(null, false);
            }
            return new SecureCredentialStore(encrypted, true);
        } catch (GeneralSecurityException | IOException | RuntimeException ex) {
            // OEM Keystore bugs, a corrupted encrypted file, or a locked user profile all land here.
            Logger.error("PrismSecureStore: encrypted store unavailable, credential persistence disabled", ex);
            return new SecureCredentialStore(null, false);
        }
    }

    /** True only when the alias really exists inside AndroidKeyStore - not merely when a handle opened. */
    private static boolean masterKeyAliasResolvable(String alias) {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            return keyStore.containsAlias(alias);
        } catch (Exception ex) {
            Logger.error("PrismSecureStore: cannot inspect AndroidKeyStore", ex);
            return false;
        }
    }

    boolean isKeystoreBacked() {
        return keystoreBacked && prefs != null;
    }

    String read(String key) throws CredentialStoreException {
        if (!KEY_SHAPE.matcher(key).matches()) {
            throw new CredentialStoreException(CODE_BAD_KEY, "凭证键名不符合命名规范");
        }
        return requireStore().getString(key, null);
    }

    /** Writes only credential-shaped payloads; everything else is refused rather than silently stored. */
    void write(String key, String value) throws CredentialStoreException {
        if (!KEY_SHAPE.matcher(key).matches()) {
            throw new CredentialStoreException(CODE_BAD_KEY, "凭证键名不符合命名规范");
        }
        if (RESERVED_SESSION_KEY.matcher(key).matches()) {
            throw new CredentialStoreException(CODE_PRIVATE_SESSION_KEY, "私密会话凭据禁止落盘");
        }
        if (value.length() > MAX_VALUE_LENGTH
                || !(JWT_SHAPE.matcher(value).matches() || DEVICE_ID_SHAPE.matcher(value).matches())) {
            throw new CredentialStoreException(CODE_BAD_VALUE, "写入内容不是可识别的授权凭证");
        }
        requireStore().edit().putString(key, value).apply();
    }

    /**
     * Removes one key. There is deliberately no clearAll(): the 一键清理 action of AC-18 must not be
     * able to reach Domain 1, so the only wipe primitive here is per-key and caller-explicit.
     */
    void clear(String key) throws CredentialStoreException {
        if (!KEY_SHAPE.matcher(key).matches()) {
            throw new CredentialStoreException(CODE_BAD_KEY, "凭证键名不符合命名规范");
        }
        requireStore().edit().remove(key).apply();
    }

    /** Fail-closed gate: null here means the device gave us no usable hardware key, so nothing is written. */
    private SharedPreferences requireStore() throws CredentialStoreException {
        if (prefs == null) {
            throw new CredentialStoreException(CODE_UNAVAILABLE, "本机硬件密钥不可用，无法安全保存授权凭证");
        }
        return prefs;
    }

    /** Checked exception carrying a stable ASCII code; the UI copy stays on the TypeScript side. */
    static final class CredentialStoreException extends Exception {
        final String code;

        CredentialStoreException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
