# 单文件 Markdown 编辑器（File System Access API）

浏览器内运行的单文件 Markdown 编辑器，无构建、无外部依赖：直接用支持
[File System Access API](https://wicg.github.io/file-system-access/) 的浏览器
（Chrome / Edge，需在 `https://` 或 `localhost` 下；`file://` 也可但能力可能受限）
打开 `index.html` 即可。

```
npm test          # 运行 17 个核心逻辑测试（Node >= 18，零依赖，node:test）
```

## 功能与需求对照

| 需求 | 实现 |
| --- | --- |
| 授权后打开/保存文件 | 工具栏「打开文件…」「保存」（Ctrl/⌘+S），基于 `showOpenFilePicker` 与 `createWritable` |
| 保存前重读 + 内容摘要比对 | 打开时记录磁盘内容 SHA-256；每次保存先 `getFile().text()` 重新读取并比对摘要 |
| 发现外部修改则暂停写入 | 摘要不一致时写入流程挂起，弹窗并列展示**磁盘版**与**草稿版**，三选一：用草稿覆盖 / 使用磁盘版 / 取消 |
| 授权撤销、写入失败、页面意外关闭 | 未保存草稿（防抖自动写入 + `pagehide`/`beforeunload` 兜底）保留在 IndexedDB，记录 `baseText`、`baseDigest`、`openedAt`，草稿卡片明确标出「所属文件版本：打开时版本 vxxxxxxxx（打开时间）」 |
| 重新授权后不能自动覆盖较新磁盘文件 | 重新授权仅更新权限徽标，**不会**触发保存；再次点击保存仍重新读取、比对，磁盘较新时同样弹冲突框 |
| 不支持该 API 时 | 自动隐藏「打开/保存/另存为」，显示黄色提示条；可「导入…」编辑并「下载副本」，状态栏文案为「已下载副本到本地，原文件未被修改」，**任何路径都不会显示「已保存到原文件」** |
| 可替换文件句柄测试 | 核心层只依赖适配器（`queryPermission / requestPermission / read / write`）；测试中的假句柄可模拟权限丢失、外部改写、写入故障、挂起/放行读取（迟到读取） |

## 结构

`index.html` 内含两个脚本段，便于测试：

1. `<script id="mde-core">` —— **不接触 DOM** 的纯逻辑（会话状态机、保存流程、
   摘要、IndexedDB/内存草稿库、原生句柄适配器），挂载到 `window.MDE.core`。
2. `<script id="mde-ui">` —— 浏览器内的 UI 引导（工具栏、编辑器/预览、冲突弹窗、
   草稿面板、快捷键、关闭兜底）。

保存流程的关键不变量（`createSession().save()`）：

```
查权限（queryPermission，必要时 requestPermission）
  └─ 非 granted → status=denied，立即落草稿，不写入
重读磁盘
  └─ 读取失败 → status=error，立即落草稿
摘要比对 diskDigest vs baseDigest
  └─ 不一致 → status=conflict，挂起等待用户裁决（draft / disk / cancel）
写入
  └─ 失败 → status=error，立即落草稿；成功 → 更新基线摘要并删除草稿
```

每次「打开 / 保存 / 另存为 / 恢复」都会使保存序号 `seq` 递增；之前尚未完成的
读取与冲突 Promise 一律作废（返回 `superseded`），因此迟到读取不会污染新会话、
不会弹陈旧内容、不会产生多余写入。

草稿记录字段：`id, adapterKind(native|import), handle(原生句柄，可结构化克隆),
name, text, baseText, baseDigest, openedAt, updatedAt`。保存成功后草稿删除；
只有「未保存」的内容才会保留。

## 测试（test/editor.test.js）

从 `index.html` 提取 `mde-core` 脚本，在 Node `vm` 沙箱（注入 Web Crypto、
TextEncoder）中运行，用可替换的假句柄覆盖：

- 正常打开/编辑/保存、未修改跳过
- 外部改写 → 冲突暂停 → 覆盖 / 采用磁盘版 / 取消 三种裁决
- 权限撤销 → 拒绝写入且草稿保留并标注版本；重新授权不自动保存；
  撤销期间磁盘被改写时重新保存仍被拦截
- 写入失败保草稿、故障恢复后重试成功
- 迟到读取：读取挂起期间发起新保存、旧冲突未决时发起新保存、打开新文件作废旧保存
- 关闭后从草稿恢复：版本信息完整，磁盘较新时仍触发冲突
- 导入模式不可保存到原文件、下载文案不宣称写回

## 浏览器手动验证建议

1. 打开文件 → 用外部编辑器改动同一文件并保存 → 回到页面按 Ctrl+S，应出现磁盘/草稿对比弹窗。
2. 编辑后在浏览器站点设置中撤销该文件的授权（或重新加载后权限变为 prompt）→
   保存被拒，底部「本地草稿」可见版本标注；通过权限徽标重新授权后，不会自动写入。
3. 编辑后直接关闭标签页 → 重新打开 `index.html`，底部「本地草稿」可恢复；
   若磁盘文件期间被改动，恢复后保存仍会弹出冲突选择。
