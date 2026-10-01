# ADR-005: 锁定 Lucide SVG 图标库与日夜双模 Design Tokens

- **状态 (Status)**: Accepted (已采纳)
- **决策日期 (Date)**: 2026-09-30
- **决策者 (Deciders)**: 颜好看 (UI/UX设计师), 大湾区靓仔 (项目总监)

---

## 背景与问题陈述

为坚决铲除 AI 生成界面与廉价聚合软件中的“AI 模板味”、“紫粉渐变”与“Emoji 当功能图标”的顽疾，必须在设计系统层面建立不可逾越的刚性代码规范。

---

## 决策结论 (Decision Outcome)

1. **P0-1 零 Emoji 功能图标**：
   - 全项目 100% 锁定 **Lucide Icons**（内联 SVG Sprite，2px 描边），尺寸严格收敛为 `16px`（行内）、`20px`（按钮）、`24px`（独立图标），全流程跑正则扫描校验。
2. **P0-2 零紫粉渐变**：
   - 严禁 `linear-gradient(135deg, #7C3AED->#EC4899)` 套路；
   - 品牌主强调色锁定流媒体院线级**琥珀金 `--accent: #E5A93C`**，夜间主背景锁定 OLED 深度省电的**黑曜石夜空 `--bg: #080A10`**，日间主背景锁定**象牙纯白 `--bg: #F5F6FA`**。
3. **P0-3 零裸 Hex 色值**：
   - 核心样式 100% 消费 `src/styles/design-tokens.css` 与 `src/styles/design-tokens.json` 中的标准 CSS 变量；`design-tokens.css` 为唯一样式真相源，`design-tokens.json` 必须与其保持同源对齐。
4. **动效缓动收敛**：
   - 全项目不定义、不使用弹性/回弹缓动（`--ease-bounce` 已移除），统一使用标准缓动与减速缓出；`prefers-reduced-motion` 下所有时长 Token 归零。
5. **双模对比度约束**：
   - 浅色模式下 `--accent` 底上的前景统一取 `--accent-on: #131720`（深色文字），禁止使用白字；任何新增前景/背景组合在合入前须按 `--surface` 实测对比度。
