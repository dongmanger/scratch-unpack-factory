# 1.0 功能与验收清单

交付目标：对 TurboWarp 及 02Engine 已支持产物，提取工程及资产，保留变量/列表/广播的名称、作用域 ID 与初值；对预编译代码产生可编辑 SB3 积木，保存原始及解混淆源码，逐脚本记录无法恢复的原因；通过真实编译器、显式运行时对照和编辑器 fixture 验收，并区分语义重建与原始结构保留。

当前 package 为 `1.0.0`。本清单将“已交付的受支持范围”和“编译产物本身无法提供的证据”分开记录；未知模板不会被静默转成错误积木。编译器优化或打包删除的信息可能不再可逆，恢复报告必须保留该边界。

| 功能/门槛 | 验收证据 | 当前证据状态 |
| --- | --- | --- |
| 历史 HTML/ZIP/嵌入 SB3 提取 | 严格长度、CRC、路径、资源、歧义测试 | 已验收：19/19 容器回归通过 |
| EXE/ASAR 静态载荷 | PE32/PE32+、ASAR header/path/offset/外部资源边界 | 已交付静态严格解析；当前证据为合成容器样本，不冒称真实桌面分发件覆盖 |
| 变量/列表/广播保真 | 定义、作用域、ID、初值和引用检查 | 已覆盖真实递归工程、局部/舞台状态与广播对照；源图删除后的唯一性不作保证 |
| 解混淆 | 官方三强度语料、实际 02 packager 4.2.2 形状、输入不执行和残留报告 | 已验收：真实 02 八个 HTML/ZIP 产物 residual/unresolved 均为空；未知副作用保留原文 |
| AST 到积木 | 闭合语法整段识别、递归图连接、未知语句事务性拒绝 | 已验收受支持模板；未知模板事务性保留 factorySource 并记录原因 |
| 事件帽子 | metadata、作用域和执行条件完整保留 | 已覆盖旗标、广播、按键/点击/背景/克隆及严格 edge/predicate 模板；全调度等价仍按场景报告 |
| 条件/循环/算术 | IR 优化形状、类型转换、NaN 边界、yield 调度 | 已覆盖受支持模板并纳入真实 VM 回归；原始优化前图不唯一 |
| 列表/运动/外观/声音/感知/画笔/标准扩展 | 单类与组合的恢复/重编译/状态对照 | 已交付受支持原生命令与 reporter；renderer/audio/像素和动态扩展按适配器边界报告 |
| 自定义过程 | 参数顺序/类型、调用、W/Z、返回和依赖图 | 已交付签名恢复、W/Z 区分、依赖图/SCC 计划与 29 项过程验证；原参数 metadata 仍可能是合成值 |
| 动态 VM 证据 | 显式执行、超时/步数边界、worker 报告 | 已交付 `verify`：默认拒绝、显式 `--allow-execute`、worker/V8 限制、状态/广播对照；不宣称安全沙箱 |
| SB3 编辑器打开 | 真实 editor fixture 加载、积木/资产/绿旗/save-reimport | 已有 TurboWarp editor fixture 证据；范围限该 fixture，不外推全部 opcode |
| 真实 02 编译器 | compileProjectFromJSON 与 loadCompiledProject 实际往返 | 已验收随包 VM 与研究版 VM 的真实编译/运行回归 |
| 真实 02 完整打包器 | none/light/balanced/strong × HTML/ZIP 对照 | 已验收 8 个真实 packager 产物，重编译状态与可信源一致 |
| 产品接口/报告 | CLI 状态/退出码/覆盖保护、JSON/Markdown、源 hash/限制 | 已验收 `unpack`、`validate`、`deobfuscate`、`verify` 及 legacy CLI 回归 |
| 发布 1.0 | 安装可复现、版本/文档/测试/证据一致 | `package.json=1.0.0`；`npm ci --ignore-scripts` 复现安装；`npm test` 串行 1009/1009，容器 19/19 |

源码覆盖基准来自当前02engine仓库：jsgen包含90个输入IR标签、75个指令IR标签；原生irgen有127个不同Scratch opcode字符串；compat-blocks列31项，正常29项走fallback。该数字描述源码分支，不表示已恢复项数。动态扩展需要对应getInfo/schema；未知字段与输入类型、mutation不能从字符串值猜测。

最终审计必须逐条关联实际文件、样本来源、运行命令、对照结果和已知损失。结构通过、行为样本通过、编辑器通过与原始结构一致是不同证据，不相互代替。
