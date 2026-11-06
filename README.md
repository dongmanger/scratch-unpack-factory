# Scratch 解包还原工厂

把 **TurboWarp / 02Engine 打包出来的 HTML 或 ZIP** 还原成可打开、可编辑的 `.sb3`。

不是"猜积木"：每一步恢复要么有源码级证据，要么经**真实 02 编译器重编译验证**——编译器把还原出的积木编回与产物逐字节相同的 JavaScript，才保留；做不到就如实报告未恢复，绝不伪造。

[![test](https://github.com/OWNER/REPO/actions/workflows/test.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

## 实测指标

真值工程 30 角色 / 515 顶层脚本 / 15 507 块 / 47 广播，产物为 21.9 MB Strong 混淆的 02Engine HTML：

| 指标 | 结果 |
|---|---|
| 脚本召回 | **77.5%** (399/515) |
| 脚本精确 | **88.5%** (399/451) |
| 块召回 | 70.1% |
| 块精确 | 84.1% |
| 块膨胀 | **0.83x**（无自造积木） |
| 结构校验 | **0 错 0 警** |
| 广播定义 | 47/47 完全正确 |

默认的 `oracle` 恢复模式是 `strict` 静态模式召回率的 **4.3 倍**（77.5% vs 18.1%）。

关于这些数字的边界、以及剩余缺口具体在哪，见 [RECALL-PRECISION.md](RECALL-PRECISION.md)。**77.5% 是"签名完全一致"的严格口径；按"过程定义是否存在"算，实际恢复率是 93.8%（271/289）。**

## 安装

要求 Node.js 20 及以上。

```bash
git clone <this-repo>
cd <this-repo>
npm ci --legacy-peer-deps
node bin/factory.mjs --help
```

`--legacy-peer-deps` 用于绕开 `@turbowarp/packager` 与 `javascript-obfuscator` 的 peer 依赖冲突（仅测试用，运行时不需要它们）。

## 快速开始

```bash
# 还原一个打包件
node bin/factory.mjs unpack project.html -o out/

# 校验产物
node bin/factory.mjs validate out/project.reconstructed.sb3

# 跑测试（1195 个用例，约 3 分钟）
npm test
```

## 两种恢复模式

| 模式 | 脚本召回 | 说明 |
|---|---|---|
| `oracle`（默认） | 77.5% | 每项恢复都经真实 02 编译器重编译验证 |
| `strict` | 18.1% | 只接受能静态证明的形态 |

## 目录

```
src/       42 个模块，约 10 000 行
test/      67 个测试文件，1195 个用例
bench/     评分脚本（召回率 / 精确率）
vendor/    02 编译器（7.2 MB，加载前先做 sha256 完整性校验）
fixtures/  测试输入（真实的 02 / TurboWarp 打包件）
```

## 文档

- [RECALL-PRECISION.md](RECALL-PRECISION.md) —— 召回率/精确率实测、缺口分析
- [DEOBFUSCATION.md](DEOBFUSCATION.md) —— 解混淆与代码美化
- [V1-ACCEPTANCE.md](V1-ACCEPTANCE.md) —— 验收标准
- [V1-PROGRESS.md](V1-PROGRESS.md) —— 测试与证据

## 许可证

MIT。`vendor/02-vm.cjs` 是 02Engine Scratch VM 及其依赖的打包产物，许可证全文见 `vendor/02-vm.LICENSES.txt`。

本项目与 Scratch Foundation 无关联。

---

## 详细说明

从 TurboWarp / 02Engine 打包件提取工程、资产与编译代码，优先保留 **变量名及作用域 ID、列表和初值、广播名及 ID、积木代码和引用连接**。原始积木图存在时保留原图；图已被清空时，按已证明的静态编译模板重构并记录不确定项。

当前包版本为 `1.0.0`。本版本交付的是带证据边界的生产工具：已覆盖的输入和模板会生成可打开的 SB3；未知或不可证明的部分保留原代码、原因和置信度，不冒称源图逐字节一致。当前测试与证据见 [V1-PROGRESS.md](V1-PROGRESS.md)。

## 使用

要求 Node.js 20 及以上。以下命令在仓库根目录执行：

```bash
npm ci --legacy-peer-deps
node bin/factory.mjs --help
node bin/factory.mjs identify project.html
node bin/factory.mjs unpack project.html -o out/
```

查看控制台给出的输出路径和 `*.fidelity-report.json`，再校验实际输出文件。原图保留时文件名为 `project.sb3`；重构与部分恢复分别为 `project.reconstructed.sb3`、`project.partial.sb3`。

```bash
node bin/factory.mjs validate out/project.sb3
node bin/factory.mjs validate out/project.reconstructed.sb3
```

显式验证原始产物与恢复 SB3 的有限绿旗场景。该命令会在 worker 中执行两侧代码，默认拒绝执行；只对拥有或获授权的可信输入使用 `--allow-execute`：

```bash
node bin/factory.mjs verify original.html out/project.reconstructed.sb3 --allow-execute
node bin/factory.mjs verify original.html out/project.reconstructed.sb3 --allow-execute --timeout-ms 30000 --max-steps 10000
```

验证报告只表示该受限场景中原始与恢复运行时最终状态、广播和可比较事件轨迹的结果，不证明源代码身份或普遍行为等价。单个输入最多 256 MiB，总输入最多 384 MiB；超时最多 600000 毫秒、每侧最多 1000000 步。worker/V8 资源限制、网络抑制和终止检查都是尽力而为，不是安全沙箱，不能隔离文件系统或原生资源。退出码为 `0=matched`、`2=invalid`、`3=mismatch/incomplete/unsupported`、`4=refused`、`1=execution error`。

仓库中真实 02Engine Strong HTML 样例的静态恢复示例：

```bash
node bin/factory.mjs unpack fixtures/real-02-v1/recursive-strong.html -o out/real-02/ --allow-partial
node bin/factory.mjs validate out/real-02/recursive-strong.reconstructed.sb3
```

`--allow-partial` 接受未验证重构/部分结果的退出状态，便于批处理；不会提高置信度或更改恢复状态。输出默认拒绝覆盖，明确需要时使用 `--overwrite`。

### 恢复模式：`--recovery oracle`（默认）与 `strict`

对 02Engine 预编译产物，`unpack` 默认用**重编译预言机**扩大可恢复范围：

1. **放宽解码**（`src/compiled-factory.mjs` 的 `relaxed`）：严格模式遇到"JS 语义可能不同于 Scratch 积木"的构造（动态列表索引的 int32 转换、原生算术的 NaN 输入、字符串比较、`<=`/`>=`、动态菜单……）会整段拒绝。放宽模式改为记录一条 `assumption` 并解出最可能的积木。结构性失败（未知语句、变量 ID 找不到）在两种模式下都仍是失败。
2. **预言机裁决**（`src/relaxed-recovery.mjs`）：把解出的积木交给随包的真实 02 编译器重编译，**只有**重编译得到的 `factorySource` 与产物里的 `factorySource` 在标识符重命名、字面量折叠、常量分支、积木 ID 之外完全一致，该项才被保留。否则这一项的积木整块撤回，不留任何残余。
3. **偏好拼写**：许多不同的积木编译成同一段 JS，解码器此时选作者更常用的那一种，而不是字面直译。每一种偏好都有名字（`PREFERENCE_KINDS`），预言机逐项核验，**只放弃编译器不认的那一种**，同一项里其余偏好保留：

   | 偏好 | 例 | 依据 |
   |---|---|---|
   | `unwrap-plus` / `unwrap-times` | `(+x\|\|0)` 解成 `x`，不解成 `x + 0`；`toNotNaN(x)` 解成 `x` | 只在会自己做数值转换的输入槽里拆；槽位表从随包编译器源码推导，有测试校验（`src/irgen-slots.mjs`）。原样传递的槽（`set v to`、自定义块实参、列表的 replace/insert/delete 索引、compat 层积木）里的强转只可能是作者放的算术块，不拆 |
   | `change-by` | `v = (+v\|\|0) + x`、`toNotNaN(v) + x`、`v + x` 解成 `change v by x` | 三种左值形态是编译器按变量类型写的；右侧是字符串（拼接）的不算 |
   | `halving` | `x * 0.5` 解成 `x ÷ 2`，`x / 2` 解成 `x × 0.5` | 编译器的强度削减双向互逆，字面直译方向正好相反 |
   | `boolean-slot` | 布尔槽里的 `toBoolean(x)` 解成直接放入 `x` | 槽自己做转换 |
   | `boolean-constant` | `true` 解成空的 `not <>`；`"false"` 实参解成留空的布尔槽 | 样本里作者 110 次用空 `not`、仅 8 次用比较；空槽编译成字符串 `"false"` |
   | `stop-this-script` | 过程内的 `return ""` 解成 `stop this script` | 两者编译成同一代码；样本里 119 比 0 |
   | `delete-all` | `list.value = []` 解成 `delete (all) of list` | 样本里 77 比 5 |

   另有三处**不是偏好，是修正**：`!(a <= b)` / `!(a >= b)` 是编译器写 `a > b` / `a < b` 的方式，解成一个比较积木而不是三重取反；裸 `+` 的一侧是字符串（字面量、`"" + x`、`letter of` 的 `(s)[i] \|\| ""`）时是拼接而不是加法；`randomFloat(0, 1)` 的边界写成带小数点的文本，否则会变成整数随机（行为改变）。
4. **按依赖顺序恢复过程**：调用只有在被调定义已存在时才有效，所以先恢复被调方，仍失败的在后续轮次重试，直到一轮没有新增。包里的顺序是编译器遇到的顺序，不是依赖顺序（样本里 411 条调用边有 190 条指向后面的过程）。互相递归的两个过程仍然无法恢复。
5. **过程定义副本**：编译器还会为每个过程的定义帽子另外生成一个无事件脚本。预言机把重编译出的定义脚本与产物里的无帽子脚本按规范化文本比较，相同的标为 `procedure-body-copy`，不再作为"独立积木栈"输出。
6. 严格模式能解的项（无 assumption）**从不参与投票、从不被撤回**；上述偏好在严格模式下一律不启用。与最初的严格输出相比，严格模式只少了不再输出的过程体副本（样本里 8 个），其余脚本与过程逐块相同；少数过程定义的编辑器坐标会因恢复顺序不同而变化。

```bash
node bin/factory.mjs unpack project.html -o out/                   # 默认 oracle
node bin/factory.mjs unpack project.html -o out/ --recovery strict # 只用原先的严格模板
```

预言机证明的是：**该项的积木编译回的程序，与打包进产物的程序相同**，因此行为相同。它**不**证明这些积木等于作者当初画的积木图：编译器会折叠常量（`6 × 50` 变成 `300`）、删除死分支、丢掉 `x - 0`，`if` 与带空 else 的 `if-else` 编译成同一文本，多个源积木图可以编译成同一个 factory，这些信息在产物里已不存在。报告里 `originalBlockStructure` 因此保持原有的低分。预言机不可用（随包 VM 加载失败）时自动回退到严格模式，并在报告 `code.recompilation.mode` 写 `strict-fallback`。

实测（`bench/score-many.mjs`，对 `10128407` 真值逐脚本做结构签名匹配；plain/Strong × html/zip 四个构建结果一致）：

| | 脚本召回 | 脚本精确 | 块召回 | 块精确 |
|---|---|---|---|---|
| 2026-10 严格模式 | 16.1% | 40.3% | 2.4% | 51.3% |
| `--recovery oracle`（当前） | **73.4~73.6%**（379/515） | **83.8~84.0%** | 62~64% | 75~76% |

过程 258/289 恢复，221 个与作者原图结构相同；事件脚本 157/159 恢复，132 个相同。398 个已恢复项全部重编译一致。严格模式（`--recovery strict`）召回仍是 16% 量级，换来的是每一项都有本地语义证明。数字来自一个真实大工程；另一个真实工程只有 2 个脚本，**泛化性没有独立验证**。未恢复部分的主要原因：产物里已不存在的信息（被折叠的常量、`x - 0`、`if` 与空 else、字面量大小写）、互相递归的过程，以及部分工程重编译带来的类型推断差异。

另一个已知限制：产物里的 factory 是在**完整工程**里编译的，预言机重编译的是**已恢复的部分**。编译器的类型推断会跨脚本、跨过程调用点（例如过程参数的类型来自所有调用处），所以未恢复的脚本会让个别项重编译出略有不同的转换，该项因此被拒绝或放弃部分偏好。这是保守方向的误差：宁可少恢复，不会多恢复。

每个被验证的脚本/过程记录 `recompilation.status`（`match` 时证据分 0.95，`basis: real-02-compiler-reproduces-shipped-factory`）。只有当所有已恢复项都 `match` 且没有未恢复项时，顶层 `confidence.code` 才上限到 0.95，`acceptance.roundTripRecompilationVerified` 才为 true；任何一项未验证或未恢复，顶层仍封顶 0.85。`canClaimComplete` 不受影响：预言机不会让产物声称"原图完整保留"。

未被恢复的项会额外输出 `*.unrecovered-source.js`：只包含这些项的解混淆源码、所属角色和拒绝原因，供人工复原。

### 解混淆的并行度

逐个 factory 的静态解混淆占总耗时的绝大部分，且各 factory 互相独立，因此在 worker 线程里并行执行（最长任务优先）。结果按输入顺序写回，与串行版逐字节相同（`test/deobfuscate-pool.test.mjs`）。`FACTORY_WORKERS=1` 强制串行，`FACTORY_WORKERS=N` 指定线程数。

### Hybrid 候选模式

在已有 factory 恢复结果之外，使用朋友的 02Engine unpackager 生成高召回候选：

```bash
node bin/factory.mjs unpack project.html -o out/hybrid --strategy hybrid \
  --peer-output ../02engine-unpackager-main/out-strong --allow-partial
```

hybrid 会把朋友生成的 `rebuilt.sb3` 原样保存为 `*.peer-candidate.sb3`，并生成 `*.hybrid-report.json`。候选脚本会经过角色、帽子 opcode、引用闭合和 unresolved 占位检查；结构完整但没有逐脚本行为等价证明的结果只标记为 `candidate-only-unverified`，不会写入正式 SB3。正式输出仍使用 factory 的高精度恢复结果。

对 `10128407-strong.html` 的实测（`bench/diagnostics/peer-align.mjs`、`peer-proc-quality.mjs`）显示这一路径的增量很小：factory 仍未恢复的 311 个脚本中，朋友的输出只有 42 个能按顶块 ID 对上，其中仅 4 个通过结构检查；它的过程体与真值相比，242/286 个相似度低于 80%，只有 9 个完全一致（factory 同口径为 74/124 完全一致）。因此默认的 `--recovery oracle` 不使用朋友的输出。该模式保留，供想人工对照朋友结果的场景使用。

使用 `--peer-decompiler <目录>` 可以让 factory 调用朋友工具；默认使用 `--peer-deobfuscator none`，不会执行朋友的反混淆库。只有明确指定 `--allow-peer-execute` 后，才允许使用 webcrack 等可能执行输入代码的反混淆器。

### 静态与动态模式

`auto`（默认）与 `static` 使用静态提取和有限 AST 分析，不执行输入 HTML 或 `factorySource`。编译包提取后自动进入解混淆与积木恢复，无需另行调用 `deobfuscate`。

### 结构美化（默认开启）

`unpack` 默认对**模板恢复的 IR** 做结构美化后再生积木图：布尔输入上下文中的 `not(not(x))`（02 编译器 `toBoolean` 形状）折叠为 `x`，与解释器布尔语义逐值等价；编辑器布局使用不重叠网格，注释位置随帽子。该变换只作用于已证明的封闭模板形状，不触碰保留原图，不伪造未恢复内容。嵌套 SUBSTACK/SUBSTACK2 递归应用，语义（含分支与循环嵌套）不变。

报告字段（`fidelity-report.json` 的 `code.beautify`）把两件事分开记：

- `applied` / `enabled` / `scriptsTouched` / `doubleNotCollapsed` —— **结构改写**是否真的发生、动了几个脚本、折叠了几处。`enabled` 的含义是"确实改写了"，不是"门槛允许尝试"。
- `layoutApplied` / `layout` —— **编辑器布局**是否重排。它和结构改写是两件独立的事。

**oracle 恢复模式（默认）不做结构改写，只重排布局。** 原因：双重否定在积木层面确实等价，但产物里的 factory 把这次类型转换写成了 `toBoolean(...)`，折叠后积木会重编译出与产物不同的 JavaScript，重编译校验必然拒绝该项。oracle 因此保留编译器验证过的积木图，报告如实标注 `applied: false` 且 `reason` 为 `oracle-verified-graph-retained-structural-rewrite-not-applied-layout-only`。需要结构改写时用 `--recovery strict`。

### 代码美化（默认开启）

`unpack` 与 `deobfuscate` 默认对解混淆后的 `factorySource` 做**仅标识符重命名**的可读性恢复（`src/pretty-code.mjs`），不执行输入、不改字面量与结构：

- 变量/列表别名按工程元数据权威反查命名：`const _0xe6c410 = stage.variables["…id…"]` → `const l_LightMod = …`（`v_` 变量 / `l_` 列表前缀，作用域严格限定）；反查不到保留原名并记录原因。
- 外层工厂函数 → `factory`，内层函数 → `script` 或 `proc_<proccode 清洗>`；混淆形态的循环计数器/临时量编号化为 `i0..` / `t0..`。
- 运行时 helper（`startHats` 等）、参数（`thread`/`p0..`）、编译器池名（`a0/b0`）不动。
- 每个工厂改名后做 **α-等价验证**（重解析 + 平行结构比对，改名映射必须全局一致无双射冲突）；任何不一致整体回退到解混淆原文。逐工厂统计见 sidecar 的 `pretty` 字段与报告的 `deobfuscation.prettyRenamedTotal`。

`--no-beautify` 同时关闭结构美化、布局重排与代码美化（三者都不做，产物保留恢复出的原始坐标）。

只有显式 `--mode dynamic` 才启动本机 Chrome/Edge、执行产物并收集运行时辅助快照：

```bash
node bin/factory.mjs unpack project.html -o out/dynamic/ --mode dynamic --timeout 120
node bin/factory.mjs unpack project.html -o out/dynamic/ --mode dynamic --headed --allow-partial
```

动态模式用于有授权的产物，建议隔离环境。**原始容器数据优先于运行后 VM 数据**：不会用已经变化的变量、列表或角色位置覆盖容器初态。加载钩子会抑制 `start/greenFlag` 并保存快照；私有上下文不暴露 `window.vm` 时仍可能无法取得快照，报告保留差异和限制。

### Scratch 1 / Scratch 2 转换

CLI 检测到真实 `ScratchV01/02` 二进制或 SB2 `project.json` 后，自动使用随包的真实 VM 和 Storage 适配器转换，无需研究目录或 `--vm-module`：

```bash
node bin/factory.mjs unpack old-project.sb -o out/sb1/ --allow-partial
node bin/factory.mjs unpack old-project.sb2 -o out/sb2/ --allow-partial
```

`--vm-module` 仍可显式指定可信本地 VM 模块，覆盖默认适配器：

```bash
node bin/factory.mjs unpack old-project.sb2 -o out/custom-vm/ --vm-module ./trusted-vm.cjs --allow-partial
```

转换使用 `loadProject/saveProjectSb3`，抑制运行与绿旗，并禁止加载工程中的扩展 JavaScript。真实 SB1 parser 样本和使用真实资产的 SB2 工程已有转换、引用与重载回归；证据不是所有旧格式积木的行为证明。转换会重新生成 ID、调整布局或规范化名称，报告包含 `legacyConversion`、初态与资产核对结果，状态保持 `reconstructed-unverified`。未知二进制不会改扩展名冒充 SB3。

## 输出状态与证据

以下以输入文件名 `project` 为例：

| 状态 | 工程文件 | 默认退出码 | 含义 |
| --- | --- | --- | --- |
| `preserved` | `project.sb3` | 0 | 产物内存留积木图原样保留，结构与引用检查通过 |
| `reconstructed-unverified` | `project.reconstructed.sb3` | 3 | 编译模板重构或旧格式转换；本次 CLI 未执行编辑器、重编译和行为验收 |
| `partial` | `project.partial.sb3` | 3 | 有脚本/过程未恢复，或只能取得运行时数据 |
| `invalid` | 不写工程，仅写报告 | 2 | 结构、引用、资源或编译包无效 |

`unpack --allow-partial` 将可接受的退出码 3 改为 0，不接受 `invalid`。未知格式、参数错误等退出 1。`validate` 只检查工程结构，成功退出 0，失败退出 2。

输出按适用情况附带：

- `project.fidelity-report.json` / `.md`：变量/列表/广播 inventory、逐脚本/积木/过程置信度、未恢复原因、源代码 hash、合成元数据、结构检查和运行时差异。
- `project.compiled-project.json`：提取的原始编译包，保留完整 `factorySource`。
- `project.deobfuscated-compiled-project.json`：静态解混淆后的编译包及逐 factory 报告，供复核与后续分析。
- `project.unrecovered-source.js`：仅在有未恢复项时输出，列出这些项的解混淆源码、所属角色和拒绝原因。

置信度是 **规则证据分，不是统计正确率**。`0.85` 不表示正确概率为 85%。

| 证据 | 分数 | 限制 |
| --- | --- | --- |
| 从产物原始 JSON 直接复制 | 1 | 仅针对产物内信息，不能恢复此前被删除的内容 |
| 普通事件 metadata + ID 对应定义 | 0.98 | 帽子与脚本体分开计分，布局重新生成 |
| 完整封闭 AST 编译模板 | 0.85 | 不代表原始图唯一，也不自动获得行为验收标志 |
| 重编译预言机确认 | 0.95 | 积木经真实 02 编译器重编译后与产物 factory 等价；不证明等于作者原图 |
| 过程体及位置参数重构 | 0.75 | 参数名、ID、默认值合成，原 warp 声明未知 |
| 唯一名称回退 / 无事件 metadata 的独立栈 | 0.65 | 名称有歧义即拒绝；独立栈不添加自动执行事件 |
| 未支持、有歧义或无法恢复 | 0 | 保留原代码和原因 |

报告分别记录脚本体、原始结构、变量名和广播名证据；恢复一个帽子不会提高未恢复脚本体的分数。重构脚本和过程附加置信度注释。外部 fixture 的重编译/浏览器证据不会自动写入任意 CLI 输出：当前 `acceptance.browserEditorLoadVerified`、`roundTripRecompilationVerified`、`behaviorEquivalenceVerified` 仍为 false。

## 当前静态反编译范围

`src/compiled-factory.mjs` 递归解析已支持的 02 编译模板，检查作用域、类型转换、helper 参数及调度伴随语句。整段脚本体必须匹配，遇到未知操作不会跳过语句后把前缀当作完整恢复。

| 类别 | 当前模板范围与边界 |
| --- | --- |
| 事件 | 绿旗、广播接收、按键、角色/舞台点击、背景切换和克隆启动；要求唯一 metadata 与正确角色身份。可执行 edge/predicate 模板包括阈值、碰撞和视频运动帽子，完整检查条件、edge 状态、retire 与 yield 伴随语句；不据此宣称所有 edge 调度已验证。 |
| 控制 | 嵌套 if/else、repeat、forever、repeat-until、wait-until、while、for-each、计时 wait，以及已匹配的停止/克隆/计数器模板；循环 yield、退出和 warp 形状必须符合模板。 |
| 运算与侦测 | 已匹配的算术、Scratch 比较/布尔转换、字符串、随机数、mod、数学函数，以及位置、计时、鼠标、按键、造型/背景和部分侦测 reporter。需要相应类型、非 NaN 或字面量证明；JavaScript 表达式不是任意翻译为 Scratch 积木。 |
| 变量与列表 | 作用域 + ID 解析赋值、精确云变量同步伴随语句、列表添加/清空/删除/插入/替换、取项、长度和包含。列表索引限制为可证明的常量及对应模板允许的特殊索引词；动态索引的 int32/floor 差异未证明。 |
| 运动与外观 | 已匹配的移动、转向、坐标、大小、显示/隐藏、说/想、图层、效果、造型与背景切换等原生调用。菜单、数值转换与伴随调用均有检查。 |
| 原生命令扩展 | `recovery-native-commands.mjs` 的形状回归覆盖 27 个操作 opcode，其中 13 个画笔命令，另含效果、监视器显示/隐藏、克隆、停止、计数器和造型/背景模板。这是该解码器的模板范围，不是全项目恢复数量；无 renderer 的状态回归不证明画笔像素结果。 |
| 兼容层 | 精确 `executeInCompatibilityLayer` 调用可恢复已知静态 schema 的字段、输入、菜单及有限 reporter。当前 schema 有 199 个去重条目，包含菜单/常量等元数据，**不等于已恢复或行为验证的 opcode 数**；动态扩展 schema、分支 frame 与未知调用不猜测。 |
| 自定义过程 | 按 `%s/%n/%b` 和 `p0/p1/...` 位置恢复定义、调用、参数 reporter 与已匹配返回模板。参数名、ID、默认值均为合成；`syntheticMetadata` 记录 `originalWarpDeclarationUnknown` 与 `chosenWarp`。混合 W/Z 变体及一般递归/调度等价尚未全部证明。 |
| 独立积木栈 | 编译脚本没有事件 metadata 且模板匹配时，保留为不自动执行的顶层栈，不猜测绿旗帽子。 |

特别保留的拒绝边界：02 的 `listContents`（数字项拼接）和 `listIndexOf`（混合数字/字符串相等）helper 与解释器存在语义差异，当前拒绝这两种原生 helper 重构。schema 中存在 `data_listcontents/data_itemnumoflist` 不能消除该限制。动态菜单的未导出闲置 shadow 默认值在支持路径中合成，并记录 `syntheticMenuDefaults`；部分原生菜单仍要求字面量。

## 容器提取与严格校验

- HTML / ZIP / SB3：处理 TW 与 02 已知编码、逐块 base85 padding、编译包与资产；从 `project.json` 判定 SB3/SB2。
- EXE：静态校验 PE32/PE32+ 和附加 ZIP，提取其中已验证的工程、`project.zip` 或自包含 HTML，不启动程序。
- ASAR：读取独立、完整的 Electron 兼容 ASAR，校验 pickle/header、packed 文件范围与声明的 SHA-256；缺失 `.asar.unpacked` 外部文件明确拒绝。
- 路径隔离、ZIP CRC32、大小/数量/深度上限、多工程歧义拒绝，以及资产 MD5 声明核对。MD5 warning 不等于媒体可解码证明。
- 工程检查包括变量/列表/广播定义与引用、恰一舞台、积木 parent/next/input 连接、悬空引用和 next-cycle；保留字体与扩展附加数据。

EXE/ASAR 的现有容器证据来自 [合成容器回归](test/executable-unpack.test.mjs)，不证明任意真实 NW.js/Electron 可执行文件、安装程序或运行时身份均受支持。未知动态扩展的 schema 仍未知。

## 解混淆与可复核证据

独立处理 JavaScript：

```bash
node bin/factory.mjs deobfuscate factory.js -o out/js/
```

输出 `factory.deobfuscated.js` 与 `factory.deobfuscation-report.json`。引擎不执行输入代码，支持官方 `javascript-obfuscator@4.1.1` 三档生成形状，以及真实 02 packager 锁定 `4.2.2` 的直接 decoder 形状；轮转前缀证明、副作用刷新与原样回退见 [DEOBFUSCATION.md](DEOBFUSCATION.md)。

| 证据 | 当前结论与范围 |
| --- | --- |
| [真实 02 manifest](fixtures/real-02-v1/manifest.json) | 真实 packager 生成 none/light/balanced/strong × HTML/ZIP 共 8 个产物，记录源 revision、API、选项、hash 和初次恢复结果；初次混淆档结果是历史记录。 |
| [刷新后的 evidence.json](fixtures/real-02-v1-reverified/evidence.json) | 同一 8 个产物均无未恢复脚本/解混淆 residual；恢复工程经真实 02 VM 重新编译，已记录最终状态与可信源工程一致。这里的“重编译”指实际 VM 编译及状态差分，不是编译 JSON/源码字节完全相同；无 renderer/audio，结论限该 fixture。 |
| [编辑器 evidence.json](fixtures/editor-acceptance-v1/editor-evidence.json) | 一份可信递归恢复 fixture 在 TurboWarp 编辑器加载资产和积木、核对初值、执行绿旗并观察导出字节；本地截图路径在 JSON 的 `screenshot`。该次导出未重新导入，不是全部输出的编辑器验收。 |
| [源码覆盖 inventory](fixtures/v1-coverage/coverage.json) | 区分 schema、解码源码提及、测试源码提及与行为证据；此 audit 不运行测试，不提供语义覆盖百分比。 |
| [最终全量测试快照](final-test-v1-robust.log) | 19/19 历史容器用例及 1009 个 node:test 用例通过、0 失败、0 跳过、0 todo（该快照；2026-11-04 起为 1185 个用例，全部通过）；`npm test` 使用串行调度以避免多 worker/子进程争用。 |

运行项目测试：

```bash
npm test
```

含真实编译器/旧格式差分的测试需要本地研究版 VM 及其依赖；默认位置为 `../research/02engine/scratch-vm`，可用 `FACTORY_02_VM_ROOT` 指向同版本源码。普通旧格式 CLI 转换使用随包 VM，和研究测试的依赖条件分开。

**源信息损失不可逆**：真实 TW packager 的 minify 会重写 block ID、删除布局和普通注释；02 编译还可能折叠常量、删除分支、展开循环并清空原图。`preserved` 仅表示产物内存留图保留；重构的是受支持的语义结构，不能保证打包前源文件逐字节复原或唯一原始积木图。结构校验、单个 fixture 行为匹配和规则置信度都不能替代全功能验收。
