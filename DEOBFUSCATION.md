# 通用解混淆引擎说明

`src/deobfuscate.mjs` 使用有预算边界的 Babel AST 分析与静态解释器，**不执行输入 JavaScript**。当前证据包括官方 `javascript-obfuscator@4.1.1` Light/Balanced/Strong 生成语料，以及真实 02Engine packager 使用的 `4.2.2` 直接 decoder 形状。版本与代码形状有已验证样本，不表示任意混淆程序均可解开，也不表示 SB3 或 1.0 全功能验收已完成。

## 使用与输出

在 `factory/` 目录执行：

```bash
node bin/factory.mjs deobfuscate factory.js -o out/js/
```

输出 `factory.deobfuscated.js` 和 `factory.deobfuscation-report.json`。已有文件默认拒绝覆盖，可显式使用 `--overwrite`。`partial` 退出 3，`transformed/unchanged` 退出 0；退出 0 只表示该命令没有报告 residual，不代表行为等价或积木完整恢复。`--allow-partial` 的退出码调整用于 `unpack`，不会改变独立 `deobfuscate` 的退出码。

`unpack` 自动对提取的编译包中脚本和过程 `factorySource` 解混淆，再进入静态积木恢复；原始 `*.compiled-project.json` 和带逐 factory 报告的 `*.deobfuscated-compiled-project.json` 分别保留。解混淆成功与积木 grammar 支持是两层检查。

API：

```js
import {deobfuscate} from './src/deobfuscate.mjs';

const {code, report} = deobfuscate(source, {
  maxRounds: 12,
  maxSteps: 300000,
  maxSourceBytes: 4000000
});
```

`maxRounds` 范围为 1–50；静态求值步数、字符串大小和输入大小均有边界。达到求值或间接调用解析上限时保留 residual，不转为执行源码的回退路径。

| 字段 | 含义 |
| --- | --- |
| `code` | 当前静态证明范围内的 JS；轮转顺序无法证明时返回精确原始输入字符串 |
| `report.status` | `transformed`、`partial` 或 `unchanged` |
| `report.transforms` | pass、数量与证明依据，轮转可带 `proof: generated-top-level-bootstrap-prefix` |
| `report.residuals` / `warnings` | 未解 eval/Function、decoder、轮转、dispatcher、预算等事项 |
| `report.builtinEffects` | 内置对象/成员保护、作用域别名、方法来源和分析收敛/预算记录 |
| `report.staticEvaluationSteps` | 实际使用的静态求值步数 |
| `report.executesInput` | 固定为 false |
| `report.behaviorEquivalenceVerified` | 当前引擎固定为 false；测试 harness 的差分证据另行记录 |

## 字符串表、decoder 与轮转证明

1. 字面量 `eval("...")` 外壳只解析字符串，不调用 `eval`；最多展开四层。
2. 识别 provider/decoder 的作用域绑定、无参数表工厂、索引偏移和返回形状。支持重赋值 wrapper，以及真实 packager 的直接表读取 decoder；有额外调用、任意返回表达式等相似形状不按 decoder 猜解。
3. 静态处理普通字符串、Base64、RC4、URI 转义、有限数字表达式及字符串/数组方法；不执行输入函数、getter、描述符或 bootstrap。
4. 对生成的轮转 IIFE 检查参数、绑定、checksum、比较退出和同一数组的 `push(shift())` 伴随结构，在预算内查找匹配排列。表中字符能解码并不足以证明其顺序。

轮转分析以 **执行到该轮转之前可证明的顶层前缀** 为依据。允许已识别的生成声明、纯字面量声明和此前已证明的轮转；同一逗号序列表达式里的较早操作也属于前缀。可达的提升声明按真实 binding 检查，不能把较晚的词法初始化或被遮蔽的内置当成宿主默认值。

因此，位于轮转之后的业务代码对内置的修改，不会反过来阻止一个前缀已经证明的 decoder bootstrap；但业务区仍必须受到该修改的保护。前缀中有未知调用、全局/成员写入、getter、spread、非字面量初始化、未知声明或内置遮蔽时，当前规则拒绝前缀证明。嵌套轮转、插入副作用、错误校验值或无法确认的目标同样不能获得证明。

**轮转顺序未证明时精确保留原文**：API 返回 `code === source`，清空转换记录，报告 `partial` 和 `string-array-rotation-unresolved`，保留 source-text 自检文本。不会按未轮转的原表替换 decoder，也不会把保留原文计作成功解混淆。

## 业务副作用保护与每轮刷新

轮转完成后，每轮先物化 decoder 调用和字面量属性键、展开安全代理对象并规范化属性，再 **重新分析 builtin effects，最后才折叠业务内置调用**。这使 `Reflect[decode(...)]`、`Object[keys.method]` 和编码的 `.bind(...)` 方法来源能在解码后进入保护集合。刷新只合并新增事实，保留原分析的宽保护；同名变量以作用域和声明位置区分。

当前分析包含：

- 以作用域 binding 为键、可能对象集合为值的别名传播。声明、赋值、多来源和循环通过单调工作队列收敛；不存在多来源反复覆盖导致的振荡。
- 别名成员赋值、复合赋值、delete、自增/自减；以及 `Reflect.set/defineProperty/deleteProperty`、`Object.defineProperty/defineProperties/assign` 的目标/成员保护。
- `Reflect.set` 同时处理显式 receiver；`defineProperty/deleteProperty` 只处理 target。额外参数的求值保留，不误当作 receiver，也不替换真实调用的布尔结果或异常。
- 批量描述符和 `Object.assign` 检查全部来源、键与顺序；动态键、getter、spread、未知容器保守保护整对象，不执行属性访问器。

方法来源位于 `src/builtin-invocations.mjs`，包括 `const remove=Reflect.deleteProperty`、对象解构声明/赋值、多级别名、条件/逻辑/逗号表达式，以及动态方法键的保守合并。方法域为六种已识别的 Reflect/Object 修改方法，有限事实数上界随 binding 数计算。

直接调用、`call`、`apply` 与调用绑定函数复用副作用规则。`call` 去掉 thisArg；thisArg 前的 spread 使参数位置未知。`apply` 仅解析字面量数组或未修改、未逃逸且单次读取的常量数组；自定义 iterator、未知列表和参数位置不确定时扩大保护。重复 bind 按创建处作用域和顺序保留绑定参数，创建一个未调用的 bind 本身不算修改。

间接调用和目标解析分别限 20000 步、40 层，最多保留 32 个参数。无法解析目标或达到上限时扩大内置保护，记录 `builtin-invocation-resolution-limit` 和 partial。报告中的 `methodAliases`、`methodProcessedFacts/finiteMethodFactLimit`、`invocationResolutionSteps/Limited` 和 `argumentResolutionSteps/Limited` 可用于复核。

编码 `Reflect.deleteProperty.bind(null, String, "fromCharCode")` 的官方三档样本当前可以解开 bootstrap、刷新方法保护并保留后续 TypeError；旧文档中将这些样本列为未解轮转的描述已过时。未知较早副作用仍进入精确原文回退，两种情况的测试分开记录。

## 其他转换与拒绝边界

- 纯对象代理函数只在无副作用且参数可安全替换时展开；重复键、getter、this/arguments、可变对象及逃逸引用不展开。
- 属性访问规范化、安全结构包装拆解，以及无外部引用的 decoder 基础设施清理均需要相应证明。
- 常量 switch dispatcher 仅在 order、计数器、case 键与继续路径均可证明，且没有内部 break/continue 语义冲突时展开。
- 标准 selfDefending 正则自检序言可以删除；适用声明限业务结果，不声称保留源码字符串自省行为。
- 动态 eval、Function、网络/文件操作、动态 proxy 和未知节点保留 residual；被重写的 builtin 不折叠为宿主默认结果。

## 代码美化（pretty-code，默认开启）

`src/pretty-code.mjs` 是解混淆之后的可读性阶段，**只做标识符重命名**：变量/列表别名按工程元数据 `variables/lists` 反查真实名（`v_`/`l_` 前缀，严格限定声明作用域），工厂/内层函数规范化为 `factory`/`script`/`proc_<proccode>`，混淆形态（`_0x…`）的循环计数器与临时量编号化为 `i0..`/`t0..`。运行时 helper、参数与编译器池名不动；元数据缺失的别名保留原名并记录原因。

每个工厂独立做 **α-等价验证**：改名前后分别重解析，平行比对全部节点字段，标识符映射必须是全局一致双射；任何不一致（含同名遮蔽歧义）整体回退到解混淆原文，报告 `verification: 'failed'`。美化结果与统计写入 sidecar 逐工厂 `pretty` 字段与 fidelity 报告 `deobfuscation.prettyRenamedTotal`。`--no-beautify` 关闭。该阶段不执行输入，不改变字面量与语句结构。

即使 `report.residuals` 为空，恢复 SB3 仍需完整模板匹配。原生 JavaScript truthiness、NaN、字符串比较和 int32 转换不能随意换成解释器语义。尤其 02 `listContents/listIndexOf` helper 当前因数字拼接/混合类型相等差异而拒绝通用重构；199 条静态 compatibility schema 是参数元数据，不能当作解码覆盖或任意动态扩展支持。

## 可复核的验证范围

| 证据 | 证明内容与范围 |
| --- | --- |
| [官方语料测试](test/deobfuscate-real.test.mjs)与 [presets](test/obfuscation-corpus.mjs) | 本地 `javascript-obfuscator@4.1.1` 三档、可信 factory、固定 seed 和 plain/eval-shell；限时测试 realm 比较变量、广播、wait/yield、retire 与返回，并检查 decoder 基础设施。测试只执行自己生成的可信样本。 |
| [轮转前缀及刷新回归](test/deobfuscate-bootstrap-order.test.mjs) | 后续 Reflect bind/删除/写入成功解码，保留原行为；未知较早副作用、遮蔽、nested rotor 和预算反例精确保留输入；代理展开后重新保护方法来源。 |
| [内置调用复核](test/builtin-invocation-review.test.mjs)与 [安全测试](test/deobfuscate-safety.test.mjs) | thisArg 前 spread、解构、未知目标、iterator、TDZ、this/arguments、getter、对象修改、作用域和预算等反例。 |
| [真实 packager manifest](fixtures/real-02-v1/manifest.json)与 [build record](fixtures/real-02-v1/provenance/build-record.json) | 实际 02 packager revision `86819b1028f96f608651c137b02ef37e6f7cb9af`、VM revision `57871aba53cf739fd1f9bef2e57797f6a999f294`、构建 API/hash，以及实际锁定的 obfuscator `4.2.2`。 |
| [刷新后的八产物证据](fixtures/real-02-v1-reverified/evidence.json) | none/light/balanced/strong × HTML/ZIP 的全部脚本无解混淆 residual、无未恢复脚本；恢复工程经实际 02 VM 编译，最终状态匹配可信源工程。编译和状态差分不等于 factory 字节相同；没有 renderer/audio 证明。 |
| [最终全量测试快照](final-test-v1-robust.log) | 19/19 历史容器用例及 1009 个 node:test 用例通过、0 失败、0 跳过、0 todo；正式 `npm test` 使用串行调度以保证子进程/worker 资源可复现。 |

manifest 中最初 light/balanced/strong 的 partial 结果属于历史恢复快照；当前这八个产物的恢复结论以 `real-02-v1-reverified/evidence.json` 为准。该刷新来自 `test/refresh-real-02-recovery.mjs`，输出逐产物 `.decoded.json`、`.fidelity.json` 和 `.reconstructed.sb3`，没有把普通 CLI 报告的通用验收标志提升为 true。

这些证据覆盖具体生成形状和可信 fixture。任意混淆器、未知版本、未知动态扩展、全部 opcode、一般调度/递归和完整源图恢复仍须独立证明。规则证据分不是统计正确率，编译优化删除的 ID、布局、注释、参数元数据及原始结构也不能从可读 JS 唯一恢复。1.0 进度与剩余验收边界见 [V1-PROGRESS.md](V1-PROGRESS.md)。
