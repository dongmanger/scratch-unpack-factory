# Scratch 解包还原工厂（factory）

> 把 **TurboWarp / 02Engine 打包出来的 HTML 或 ZIP** 还原成可打开、可编辑的 `.sb3`。

别人发给你的游戏、作品，打包成了网页，源码没了。这个工具能把积木**还原回来**——不是猜，是每一步都有编译器级证据。

[![test](https://github.com/dongmanger/scratch-unpack-factory/actions/workflows/test.yml/badge.svg)](https://github.com/dongmanger/scratch-unpack-factory/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-GPL--3.0-blue)

---

## 一、factory 是什么

**一句话：编译产物的逆向还原工具。**

Scratch 项目（`.sb3`）被 TurboWarp 或 02Engine 打包后，积木图会被**编译成 JavaScript** 塞进 HTML。原始积木数据被丢弃了——你只能看到一个能跑的网页，改不了任何东西。

`factory` 做的事是反过来的：**读那些编译出来的 JavaScript，把它翻译回积木图**，输出一个你能在 Scratch / TurboWarp 编辑器里直接打开、随便改的 `.sb3`。

### 和"猜积木"的区别

市面上很多工具是**模式匹配**：看到 `a + b` 就拼一个加法积木。问题是同一个 JavaScript 可能对应多种积木写法，猜错了你也不知道。

`factory` 的核心机制是**重编译验证**（recompilation oracle）：

```
产物里的 JS  →  还原成积木  →  用真实 02 编译器重新编译  →  和原 JS 逐字节比对
                                    ↓
                          一致 → 保留（有证据）
                          不一致 → 丢弃（绝不瞎猜）
```

**能验证的才给你，不能验证的如实说"没还原"并给出原因。** 这是这个工具最重要的设计原则。

---

## 二、能做什么

| 能力 | 说明 |
|---|---|
| **识别格式** | TurboWarp HTML（4 代分块编码）、02Engine HTML、标准 sb3、ZIP 打包件 |
| **还原积木代码** | 从编译后的 JS 重建积木图，支持 200+ 积木，含自定义过程、循环、条件、广播、列表操作 |
| **还原工程结构** | 角色、变量（名 + 作用域 ID + 初值）、列表、广播（名 + ID）、素材文件 |
| **解混淆** | 支持 `javascript-obfuscator` 的 light / balanced / strong 三档，还原字符串数组、控制流平坦化、标识符重命名 |
| **代码美化** | 变量别名按工程元数据反查命名（`_0xe6c410` → `l_LightMod`），逐工厂做 α-等价验证，失败自动回退原文 |
| **布局重排** | 积木在编辑器里按不重叠网格摆好，注释跟着帽子走 |
| **保真报告** | 每个脚本的状态、置信度、证据、失败原因，JSON + Markdown 双份 |
| **产物校验** | 输出前用结构校验器过一遍，引用悬空、类型不符、名称不一致全部报出来 |
| **运行时对比**（可选） | 显式授权后，在隔离 worker 里跑原始产物与还原产物，比对最终状态 |

### 还原的分层保真度

| 层 | 保真度 | 说明 |
|---|---|---|
| 容器字节、素材文件 | **100%** | 逐字节保留，sha256 可验证 |
| 变量/广播名、作用域 ID、初值 | **100%** | 从编译包的元数据权威读取 |
| 积木代码 | **按证据分级** | 有重编译验证的才标为可信，其余标为"未验证"或"未恢复" |
| 原图布局、积木内部 ID | **不可恢复** | precompile 后永久丢失，报告里明确标注 |

---

## 三、亮眼的指标

在一份 **30 角色 / 515 顶层脚本 / 15 507 块 / 47 广播** 的真实工程上实测，产物是 **21.9 MB 的 Strong 混淆 02Engine HTML**：

| 指标 | 结果 | 说明 |
|---|---|---|
| **脚本召回** | **77.5%**（399/515） | 严格口径：签名完全一致 |
| **脚本精确** | **88.5%**（399/451） | 还原出的脚本里 88.5% 是对的 |
| **块召回** | **70.1%** | 按积木块数计 |
| **块精确** | **84.1%** | |
| **块膨胀** | **0.83x** | **关键指标：没有自造积木** |
| **结构校验** | **0 错 0 警** | 产物能正常打开 |
| **广播定义** | **47/47** | 无多无缺 |

### 三个最值得看的数字

**1. 块膨胀 0.83x** —— 还原出的块数比真值还少。这说明工具**宁可少还原，也不编造**。对比同类工具常见的 3.6x 膨胀（大量重复/错误积木）。

**2. oracle 是 strict 的 4.3 倍** —— 同一份代码、同一个产物，只切换恢复模式：

| 模式 | 脚本召回 | 脚本精确 |
|---|---|---|
| `oracle`（默认） | **77.5%** | **88.5%** |
| `strict`（仅静态证明） | 18.1% | 40.1% |

这就是"重编译验证"机制的价值。

**3. 按过程是否存在算，实际恢复率 93.8%** —— 77.5% 是"签名完全一致"的严格口径。真值有 291 个过程定义，还原出 258 个（93.8%）。差的 13 个百分点是**体内容差异**，主因是编译器优化（`if/else` 折叠、循环展开）造成的不可逆信息丢失，不是解码失败。

小样本（2 脚本 / 8 块）：**召回 100% / 精确 100% / 膨胀 1.00x**。

完整数据与缺口分析见 [RECALL-PRECISION.md](RECALL-PRECISION.md)。

---

## 四、怎么用

### 安装

要求 **Node.js 20 及以上**。

```bash
git clone https://github.com/dongmanger/scratch-unpack-factory.git
cd scratch-unpack-factory
npm ci --legacy-peer-deps
```

> `--legacy-peer-deps` 用于绕开 `@turbowarp/packager` 与 `javascript-obfuscator` 的 peer 依赖冲突。这两个包**只在测试时需要**，运行时用不到。

### 最常用：还原一个打包件

```bash
node bin/factory.mjs unpack 作品.html -o out/
```

输出 5 个文件：

```
out/作品.reconstructed.sb3              ← 直接拖进 TurboWarp 就能打开改
out/作品.fidelity-report.json           ← 完整证据（给机器看）
out/作品.fidelity-report.md             ← 同上，人读版
out/作品.compiled-project.json          ← 从产物提取的编译包原文
out/作品.deobfuscated-compiled-project.json  ← 解混淆后的编译包
```

**先看 `.fidelity-report.md`**，它会告诉你哪些脚本还原了、哪些没有、为什么。

### 其他命令

```bash
# 只识别格式，不还原
node bin/factory.mjs identify 作品.html

# 校验还原出的 sb3 结构是否合法
node bin/factory.mjs validate out/作品.reconstructed.sb3

# 运行时对比（需显式授权，会执行代码）
node bin/factory.mjs verify 作品.html out/作品.reconstructed.sb3 --allow-execute

# 只做解混淆，不还原积木
node bin/factory.mjs deobfuscate compiled.js -o out/

# 跑测试（1195 个用例，约 3 分钟）
npm test
```

### 常用参数

| 参数 | 作用 |
|---|---|
| `-o, --output <dir>` | 输出目录 |
| `--recovery oracle\|strict` | 恢复模式，默认 `oracle`（推荐） |
| `--no-beautify` | 关闭结构美化、布局重排、代码美化 |
| `--allow-partial` | 部分恢复时也返回退出码 0 |
| `--overwrite` | 覆盖已有输出 |
| `--mode auto\|static\|dynamic` | 提取模式，`auto` 默认不执行输入 |

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 完整保留 / 成功 |
| `2` | 结构无效 |
| `3` | 部分恢复或未验证重构（**正常情况**，看报告） |
| `4` | 拒绝执行 |

> 退出码 `3` 不代表失败。多数真实作品都会是 `3`——因为总有一部分无法证明。看报告的 `unresolved` 部分了解具体缺什么。

---

## 五、报告怎么看

`fidelity-report.md` 里最重要的几段：

**置信度是规则证据分，不是统计概率：**

| 分数 | 含义 |
|---|---|
| `1.0` | 原图完整保留 |
| `0.98` | 从元数据直接读取（变量名、广播名） |
| `0.95` | 重编译验证通过 |
| `0.85` | 封闭模板重构 |
| `0` | 未恢复 |

**`code.beautify` 三个字段要分清：**

- `applied` —— 结构改写是否真的发生
- `layoutApplied` —— 布局是否重排
- `enabled` —— 确实改写了

默认 `oracle` 模式**只重排布局，不改写结构**。因为折叠布尔双重否定会让积木重编译出与产物不同的 JavaScript，无法通过校验。需要结构改写请用 `--recovery strict`。

---

## 六、项目结构

```
src/       42 个模块，约 10 000 行
test/      67 个测试文件，1195 个用例
bench/     评分脚本（召回率 / 精确率）
vendor/    02 编译器（7.2 MB，加载前先做 sha256 完整性校验）
fixtures/  测试输入（真实的 02 / TurboWarp 打包件）
```

**测试状态：1195/1195 通过。** 语法解析 199 个文件 0 失败。同一输入两次运行，输出 sha256 完全一致。

---

## 七、安全说明

- **静态提取不执行输入代码**。只有 `--mode dynamic` 或 `verify --allow-execute` 才会执行，且需明确授权。
- `vendor/02-vm.cjs` 加载前先做 **sha256 完整性校验**（CommonJS 顶层代码会在 require 时执行，顺序不能反）。
- ZIP 路径遍历防护、炸弹防护（条目数 / 单条目 / 总量 / JSON 四重限额）。
- `verify` 命令的 worker 隔离**不是安全沙箱**，报告里明确声明，不做虚假承诺。
- **只对你自己拥有或获得授权的作品使用。** 还原他人作品可能侵犯著作权。

---

## 八、文档

- [RECALL-PRECISION.md](RECALL-PRECISION.md) —— 召回率/精确率实测、缺口分析
- [DEOBFUSCATION.md](DEOBFUSCATION.md) —— 解混淆与代码美化
- [V1-ACCEPTANCE.md](V1-ACCEPTANCE.md) —— 验收标准
- [V1-PROGRESS.md](V1-PROGRESS.md) —— 测试与证据

---

## 九、联系与许可

**作者联系方式：QQ 3949883627**

有问题、有反馈、想交流逆向还原技术，欢迎加 QQ。

**许可证：GNU General Public License v3.0**

本项目基于 GPL-3.0 开源。你可以自由使用、修改、分发，但**衍生作品必须以同样的 GPL-3.0 协议开源**，并保留原作者署名。

`vendor/02-vm.cjs` 是 02Engine Scratch VM 及其依赖的打包产物（MIT 等宽松许可），作为重编译验证的预言机使用。完整许可证文本见 `vendor/02-vm.LICENSES.txt`。MIT 与 GPL-3.0 兼容，可一并分发。

本项目与 Scratch Foundation 无关联。
