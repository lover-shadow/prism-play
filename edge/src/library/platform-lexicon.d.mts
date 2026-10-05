/**
 * `platform-lexicon.mjs` 的类型门面：只写形状。词表本体留在 `.mjs` 一处，
 * 本声明里重复列出站源名就等于开了第二份口径（还多一处会漏改的地方）。
 */

export declare const PLATFORM_WORDS: readonly string[];
export declare function platformNamePattern(): RegExp;
export declare function containsPlatformName(text: unknown): boolean;
export declare function stripPlatformNames(text: string): string;
