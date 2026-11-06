# 方法别名删除路径的证据核对

本轮目标是让已识别的内置副作用方法通过局部别名调用时仍阻止错误常量折叠，重点验证删除后的异常；同时检查该能力已接入现有解混淆和还原流水线。这里记录具体证据，不给整个通用解混淆目标标记完成状态。

| 要求 | 实现与证据 |
| --- | --- |
| 识别 Reflect.deleteProperty 方法提取后的调用 | `src/builtin-invocations.mjs` 收集成员和对象解构来源，在内置对象别名收敛后建立方法集合，沿声明、赋值及bind依赖图传播；`resolveCall`处理直接、call、apply及bind后调用。 |
| 所有可能目标的成员均受保护 | 复用 `possibleBuiltins` 和 `markMemberMutation`；字面量键保护相应成员，未知键保护所有可能目标的整对象。 |
| 多级、赋值、多来源与循环别名 | `test/builtin-method-aliases.test.mjs` 比较原代码和输出的行为；多来源循环另在子进程中设置5秒硬超时，并检查有限事实数上界。 |
| 指定反例均抛出 TypeError | 修复前定向测试失败：原代码 TypeError，输出返回 A。修复后定向测试和独立 VM 探针均得到 TypeError；报告 `remove` 的来源为 Reflect.deleteProperty，并保护 String.fromCharCode。 |
| 保持成功、失败及参数求值语义 | 测试比较删除成功 true、冻结目标失败 false、成员存在性、额外参数求值，以及本地同名绑定遮蔽。Reflect.set 方法别名的显式 receiver 也有回归。 |
| 可复用的方法别名机制 | 同一机制覆盖 Reflect.set/defineProperty 和 Object.defineProperty/defineProperties/assign；五类方法别名均有前后返回 changed 的行为测试。 |
| 报告可检查 | `src/deobfuscate.mjs` 输出 `methodAliases`、`methodProcessedFacts` 和 `finiteMethodFactLimit`。 |
| 实际流水线接入 | `src/restore.mjs` 对 scripts/procedures 的 factorySource 调用 deobfuscate，并把代码及报告传给 `recoverCompiledCode`；CLI deobfuscate 命令调用同一 API。 |
| 全量回归 | `npm test`：19/19 历史容器用例、348/348 Node 测试通过，失败/取消/跳过均为0。日志为 `final-test-current-19.log`。本轮在之前287项基础上新增61项测试。 |
| 间接调用及参数来源 | `test/builtin-method-invocation.test.mjs` 的34项测试覆盖解构、call/apply/bind、绑定创建处作用域、可变或逃逸参数数组、成功/失败和receiver；只创建未调用的bind不增加成员保护。 |
| 解析预算与保守退化 | `test/builtin-invocation-limits.test.mjs` 的13项测试验证深层bind、循环赋值、未知参数、getter、目标表达式和数组逃逸；达到上限报告partial和builtin-invocation-resolution-limit，阻止内置折叠。 |
| 对外CLI输出 | `test/builtin-invocation-cli.test.mjs` 的2项子进程测试验证报告可检查、TypeError保留、解析上限退出3及partial报告。 |
| 语义复核反例 | `test/builtin-invocation-review.test.mjs` 的12项测试覆盖thisArg前展开、解构条件/逗号来源、条件及未知目标赋值、set receiver和自定义Array iterator。 |
| 真实混淆编码bind | 同一review测试通过官方Light/Balanced/Strong各1个seed生成3个真实样本，原版/混淆版/输出均TypeError。动态属性扩大保护后轮转顺序未被证明；保留输入字节内容并报告partial及string-array-rotation-unresolved，而非错误解码或宣称完成。 |

指定输入：

```js
const remove = Reflect.deleteProperty;
remove(String, "fromCharCode");
return String.fromCharCode(65);
```

解混淆输出保留上述调用，不将最后一行替换为宿主内置的 `"A"`。引擎报告 `executesInput: false`；运行时对照仅执行限时测试中的可信程序。

本轮覆盖边界：已识别方法的成员及对象解构提取、标识符声明/赋值传播、call/apply/bind已有直接行为证据；动态方法键、未知位置和目标采用扩大保护，报告并不宣称知道实际目标。函数参数传递、对象属性中转、原型链替换和任意自定义调用机制仍不在这组测试的证明范围内。三个编码bind样本原样保留，证明的是避免误变换，并未获得可读解混淆结果。不能用348个通过结果推出任意 JavaScript 的等价保证。浏览器E2E本轮未重跑。

项目原目标还要求变量名、广播、积木代码优先以及不确定时记录置信度。已检查 `src/fidelity.mjs` 的优先级和验证标志、`src/recover-code.mjs` 的脚本置信度和未支持体处理：未知脚本体保持0分并记录原因，封闭模板重建保持 reconstructed-unverified，浏览器加载、重编译和行为等价标志不会因本轮测试通过而改成true。完整02打包器/编译器黄金语料、全积木覆盖和真实重编译差分仍没有本轮证据；编译优化删除的信息也不能据此唯一恢复。
