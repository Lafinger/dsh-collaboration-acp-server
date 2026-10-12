# 工具必须用 defineTool 包装并声明 output

状态：已采用

MVP 的所有模型可调用工具**必须**用 `defineTool()` 包装，并**必须**声明 `output { schema, render }`。

```ts
toolCtx.tools.register(defineTool({ name, description, parameters, output, execute, presentCall }))
```

## 为什么

这不是风格偏好，而是宿主 `@deepseek-ai/dsh-tools@0.1.5-rc.2` 的**运行时强制要求**。实测：

- **裸对象字面量会被静默丢弃**：`register({...})` 不抛异常、`--dump-config` 显示插件已加载、`apply()` 也确实被调用，但工具**不在模型的工具表里**。模型只会说"没有这个工具"。唯一线索是一个 `-32603` 错误，其中 `got 'type: null'` 是裸对象未被转换的指纹。
- **`output` 缺失会抛错**：`tool "x" must declare output { schema, render, presentationMeta? }`。

静默失败是最贵的一类 bug：所有中间信号都是"成功"，只有最终结果不对。

## 值得记录的取舍

**替代方案**：写裸对象。它更短，且**在 `defineTool` 出现前是合法的**——`DSH-taskboard` 就用裸对象，因为它面向 `dsh-tools@0.1.6-alpha.1`，而宿主实际提供 `0.1.5-rc.2`。

**为什么仍选 `defineTool`**：它在两个版本下都工作，提供类型推导，并且**裸对象在本机当前版本下根本不工作**。

## 后果

- **不能照抄 `DSH-taskboard` 的插件写法**。它的代码是它那个 SDK 版本的正确答案，未必是本机这个版本的正确答案。任何从它复制的模式都必须经本机实测。
- **版本错配是持续风险**：SDK 的 schema 校验规则在 `0.1.5-rc.2` 与 `0.1.6-alpha.1` 间不兼容。升级 DSH 后必须重跑冒烟验证（见[实现前验证清单](../项目管理工作台需求文档MVP/docs/验证/实现前验证清单.md)第六节）。
- `tsc` 默认"有错也产出"，因此**构建脚本必须用 `--noEmitOnError`**，否则会静默通过一个类型错误的构建。
