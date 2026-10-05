/**
 * `metadata-policy.mjs` 的类型门面。**这里只写形状，不写任何边界数字**——
 * 240/6/12/64/年份区间的唯一字面量出处是 `.mjs` 实现，本声明里出现数字就等于开了第二份口径。
 */

export declare const SYNOPSIS_MAX_CODE_POINTS: number;
export declare const TAGS_MAX_ITEMS: number;
export declare const TAG_MAX_CODE_POINTS: number;
export declare const TAG_MIN_CODE_POINTS: number;
export declare const SOURCE_TEXT_MAX_CODE_POINTS: number;
export declare const RELEASE_YEAR_MIN: number;
export declare const RELEASE_YEAR_MAX: number;
export declare const CATALOG_DIRECTORY_MAX_BYTES: number;

export declare const PUBLIC_METADATA_FIELDS: readonly string[];

export declare function cleanPlainText(value: unknown): string;
/** `stripPlatformNames` 只由打包/边缘侧注入；端侧读取路径不传，见 `platform-lexicon.mjs` 文件头。 */
export declare function normalizeSynopsis(raw: unknown, stripPlatformNames?: (text: string) => string): string | undefined;
export declare function normalizeReleaseYear(raw: unknown): number | undefined;
export declare function normalizeSourceText(raw: unknown, stripPlatformNames?: (text: string) => string): string | undefined;
export declare function normalizeDisplayTags(channelId: string, raw: unknown): string[];

export declare function publicWorkMetadata(
  channelId: string,
  raw: Record<string, unknown> | undefined | null,
  stripPlatformNames?: (text: string) => string
): {
  synopsis?: string;
  tags?: string[];
  releaseYear?: number;
  region?: string;
  language?: string;
};

/**
 * 判定对象上出现的公开元数据是否符合本模块口径；越界抛错，供打包与发布前门禁使用。
 * `containsPlatformName` 由发布侧注入的品牌词表判据（`platform-lexicon.mjs`），缺省只跑形态判据。
 */
export declare function assertMetadataBounds(
  item: Record<string, unknown>,
  label: string,
  containsPlatformName?: (text: unknown) => boolean
): true;

/** 就地消毒的纯函数版本：返回只含合法可选字段的新对象，越界字段整个丢弃。 */
export declare function sanitizePublicMetadata(
  item: Record<string, unknown>
): {
  synopsis?: string;
  tags?: string[];
  releaseYear?: number;
  region?: string;
  language?: string;
};
