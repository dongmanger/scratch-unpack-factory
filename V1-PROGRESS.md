# 1.0 进度与证据边界

当前包版本为 **`1.0.0`**。本文记录 1.0 交付范围、实际实现和可复核证据；每项证据都保留输入范围、运行场景和不可逆信息边界。使用方法见 [README.md](README.md)，解混淆算法见 [DEOBFUSCATION.md](DEOBFUSCATION.md)。

## 当前可使用的路径

在 `factory/` 目录中：

```bash
npm ci
node bin/factory.mjs identify project.html
node bin/factory.mjs unpack project.html -o out/
node bin/factory.mjs unpack old-project.sb2 -o out/legacy/ --allow-partial
node bin/factory.mjs deobfuscate factory.js -o out/js/
```

`unpack` 默认静态提取，自动解混淆编译包并尝试模板恢复；旧格式自动使用随包 VM 转换。输出文件名、状态、未恢复项与置信度以控制台和 `*.fidelity-report.json` 为准。`--allow-partial` 接受退出码 3，不提高证据级别；结构 `validate` 不执行项目。

## 实现与验证分开记录

| 范围 | 当前实现 | 已有证据与限制 |
| --- | --- | --- |
| 原图与初态 | 原始工程图优先；变量、列表、广播名称/ID/初值与角色属性核对 | `preserved` 限产物内存留图；打包前损失无法保证恢复。 |
| 递归控制与运算 | 嵌套条件/循环、等待、停止、for-each、变量、广播、类型明确的运算与 reporter | 真实 VM 递归 fixture 和各模板回归；未知语句拒绝整段脚本体，调度/类型条件不满足则保留源代码。 |
| 列表 | 添加、清空、删除、插入、替换、取项、长度、包含及对应内联伴随语句 | 索引要求支持的常量/特殊词模板；动态 int32/floor 未证明。原生 `listContents/listIndexOf` helper 因编译器/解释器差异拒绝。 |
| 运动/外观/画笔 | 已匹配的运动、坐标、方向、大小、可见性、图层、效果、造型/背景和画笔调用 | 原生命令解码器形状回归覆盖 27 个操作 opcode，含 13 个画笔命令；部分真实 VM 状态差分已有证据，清屏/图章等无 renderer 回归只证明编译形状，不证明像素输出。 |
| 兼容层 | 已知 opcode 的精确 helper 调用、字段、输入、菜单和有限 reporter | 静态 schema 有 199 个去重条目，含菜单与常量元数据；条目数不是已恢复/行为测试 opcode 数。动态扩展 schema、分支 frame 和一般 reporter 调度未全覆盖。 |
| 普通与可执行帽子 | 普通帽子由唯一 metadata 恢复；edge/predicate 条件连同状态/退出/yield 结构检查 | 普通事件包含绿旗、广播、按键、点击、背景、克隆；可执行模板包含阈值、碰撞、视频运动。真实阈值帽子已有恢复/校验/重编译用例，尚不能推出全部 edge 行为或调度等价。 |
| 自定义过程 | 按位置签名恢复定义、调用、参数 reporter、已匹配返回和 warp 执行模式 | `syntheticMetadata` 标明参数名/ID/默认值合成、原 warp 声明未知及 `chosenWarp`；有限 fixture 重编译/状态匹配。混合 W/Z 变体、一般递归和调度仍有缺口。 |
| 无事件栈 | 无事件 metadata 的已匹配脚本作为不自动执行的顶层积木栈 | 不猜测事件来源；使用独立证据分，原结构未知。 |
| EXE / ASAR | PE32/PE32+ 附加 ZIP、独立 packed ASAR 的静态提取与严格边界检查 | [容器测试](test/executable-unpack.test.mjs)全部为合成 PE/ZIP/ASAR；不冒称真实 NW.js/Electron 分发件验收。外部 `.asar.unpacked` 文件缺失即拒绝。 |
| SB1 / SB2 | 真实 VM `loadProject/saveProjectSb3` 转换，默认随包适配器，可用 `--vm-module` 覆盖 | [转换回归](test/legacy-convert.test.mjs)覆盖真实 SB1 parser 样本、真实资产 SB2 工程、初态、引用和 VM 重载；[CLI 回归](test/legacy-cli.test.mjs)包含默认适配器。转换不执行脚本，ID/布局/名称转换明确记录，不能宣称原图或全部旧积木行为已保留。 |
| 解混淆 | 官方 4.1.1 三档生成形状及实际 packager 4.2.2 直接 decoder，带前缀证明和 effects 刷新 | 编码 Reflect bind 已可解码并保持受保护调用；未知较早副作用/未证明轮转返回精确原文与 partial，不执行输入。 |

动态菜单支持路径保留实际 reporter 连接，为未导出的闲置 shadow 默认值生成合成元数据，写入 `syntheticMenuDefaults`；字面量限制或未知菜单不能绕过。任意动态扩展的字段、菜单、输入及执行语义仍须取得 schema 与独立行为证据。

## 八个真实 02 packager 产物

[manifest.json](fixtures/real-02-v1/manifest.json)记录实际 API `loadProject`、`getCompiledProjectData`、`getCompiledProjectArchiveData` 和 `Packager.package` 的产物、选项、hash 与构建来源：

- packager revision：`86819b1028f96f608651c137b02ef37e6f7cb9af`。
- VM revision：`57871aba53cf739fd1f9bef2e57797f6a999f294`，VM 版本 `2.1.46`。
- [build-record.json](fixtures/real-02-v1/provenance/build-record.json)记录实际锁定的 `javascript-obfuscator@4.2.2`；factory 官方生成语料使用本地 `4.1.1`，两个来源分别记录。

| 档位 | HTML | ZIP | 刷新结果 |
| --- | --- | --- | --- |
| none | `recursive-none.html` | `recursive-none.zip` | 两脚本恢复；实际 VM 重编译与最终状态匹配 |
| light | `recursive-light.html` | `recursive-light.zip` | 两脚本恢复；实际 VM 重编译与最终状态匹配 |
| balanced | `recursive-balanced.html` | `recursive-balanced.zip` | 两脚本恢复；实际 VM 重编译与最终状态匹配 |
| strong | `recursive-strong.html` | `recursive-strong.zip` | 两脚本恢复；实际 VM 重编译与最终状态匹配 |

当前结果见 [real-02-v1-reverified/evidence.json](fixtures/real-02-v1-reverified/evidence.json)和 [刷新日志](real-02-refreshed-evidence.log)。八项均记录：

- `unresolved: []`、`deobfuscationResiduals: []`。
- `actualVMRecompiled: true`、`finalStateMatchesTrustedSource: true`、`remainingThreads: 0`。
- 舞台与角色分数为“成功”，列表为 `[3, 5, 7]`；角色 x 为 10、方向为 105、大小为 105。

刷新目录中每项有 `.reconstructed.sb3`、`.fidelity.json` 和 `.decoded.json`，hash 在 evidence 中可核对。manifest 的初次混淆档 partial 记录用于保留历史来源，当前恢复结果以刷新证据为准。

这是同一可信递归工程的八种打包组合，证据范围包含嵌套控制、运算、变量/列表、广播、运动与大小变化。重编译表示恢复 SB3 进入真实 VM 编译器并运行状态差分；未宣称编译输出字节相同。VM 差分未挂载 renderer/audio，不能覆盖声音、画笔图像、外部设备或所有积木行为。八项状态仍为 `reconstructed-unverified`，`canClaimComplete` 未提升。

## 编辑器验收 fixture

[editor-evidence.json](fixtures/editor-acceptance-v1/editor-evidence.json)记录一份可信实际 VM 编译递归工程的恢复结果在 `https://turbowarp.org/editor` 的接受情况；[provenance.json](fixtures/editor-acceptance-v1/provenance.json)记录源 VM/hash，工程为 [recursive.reconstructed.sb3](fixtures/editor-acceptance-v1/recursive.reconstructed.sb3)。

该次浏览器检查观察到舞台/角色资产加载、积木连接、变量/列表/广播初始定义、绿旗后的结果，以及 `saveProjectSb3` 返回 2060 字节。导出字节在该次检查中 **没有重新导入**，不能宣称浏览器保存往返已验证。结论只适用于此 fixture，不适用于任意输出、全部 opcode 或过程。

本地截图由 JSON 的 `screenshot` 字段引用：[编辑器截图](C:/Users/ASUS/.zcode/cli/artifacts/sess_51946499-254b-4bdb-bfd4-69a8cddcc070/call_7efb7f4fefa14da4b9df42e77e6fd3ce-tool-result-0d94e70c-b7b1-439d-93cf-b7547f808085.png)。这是本机 artifact 路径，未复制进仓库，也不是公开 URL。

## 1.0 测试快照与证据审计

[final-test-v1-robust.log](final-test-v1-robust.log)是当前工作树的最终全量快照：容器回归 **19/19**，`node:test` **1009 tests / 1009 pass / 0 fail / 0 skipped / 0 todo**（含供应商 bundle 加载前完整性校验、恢复 AST 深度预算对抗用例和 CLI 严格参数校验的健壮性回归）。`npm test` 和 `npm run test:unit` 使用 `--test-concurrency=1`，因为解混淆子进程、真实 VM worker 与浏览器/VM 资源同时启动会造成环境级争用；各受影响测试单独运行也已通过。

[verify-cli-current-2.json](verify-cli-current-2.json)记录一次真实 SB3 对照：原始可信工程与恢复工程在随包真实 02 VM 中运行，`status=matched`、`snapshotsEqual=true`、`broadcastsEqual=true`、线程全部结束；`traceEqual=false` 仅反映原始解释线程与恢复编译线程的调度/块 ID不同，不被当作源图身份或普遍等价证明。验证器明确记录 `originalSourceVerified=false`、`securitySandbox=false` 和受限绿旗场景。

[coverage.json](fixtures/v1-coverage/coverage.json)是源代码 inventory，明确区分 schema、解码器源码提及、测试源码提及与行为证据；该审计不把源码字符串或测试总数计为全 opcode 语义覆盖，`semanticCoverageVerified=false` 与 `originalGraphUnique=false` 是编译信息损失的事实记录。

1.0 交付包含：静态容器提取、02 预编译解混淆和受证明模板恢复、SB1/SB2 随包 VM 转换、显式 worker 对照验证、过程依赖图/SCC 计划、报告与可复现回归。未知扩展、未证明参数/调度、renderer/audio/画笔像素、外部设备和编译器已删除的源图 metadata 继续按报告保留原文并标记边界。

普通 CLI 报告继续使用规则证据分，`behaviorEquivalenceVerified`、`roundTripRecompilationVerified` 和 `browserEditorLoadVerified` 默认 false。外部 fixture evidence 已通过的检查与一次用户输入的验证状态分开，不能因八个样例匹配就提升所有输出。

**原始源码损失警告保留**：编译器的常量折叠、分支删除、循环展开和 metadata 清理，使多个源积木图可以生成同一 factory。原内部 ID、布局、普通注释、原参数名/默认值与原 warp 声明可能已经不存在；重构和合成元数据必须如实报告，不能给出逐字节原样恢复或统计正确率保证。
