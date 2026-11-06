# 置信度样例来源

- original.sb3：多角色同名变量和大小写广播的源工程。
- real-tw-preserved.html：官方 @turbowarp/packager 3.13.0 Node API 的真实普通打包产物。
- template-02-synthetic.html：符合02 schema的合成明文factory，工程blocks确实清空；用于模板单测，未运行真实02编译器。
- unsupported-eval-shape-synthetic.html：拒绝执行的eval形状合成fixture，验证未恢复标记；不是官方Strong混淆产物。

这组样例不证明02三档混淆已解混淆，编辑器试开、重编译差分和行为验证尚未执行。
