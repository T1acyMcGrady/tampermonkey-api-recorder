# Tampermonkey API Recorder

一个面向测试工程师的 Tampermonkey 油猴脚本，用来在网页正常操作过程中自动捕获接口请求，判断接口成功或失败，沉淀可回放的接口模板，并导出测试报告。

它的目标不是替代 Charles、Fiddler 这类完整抓包工具，而是把测试工程师日常最常见的动作收敛成一个更轻量的工具闭环：

- 正常点页面
- 自动记录接口
- 失败即时提示
- 成功沉淀模板
- 后续批量回放
- 最终导出报告

## 项目定位

这个项目本质上是一个“测试过程中的接口录制、回放与报告助手”。

适合的场景：

- 功能测试过程中快速收集接口资产
- 回归测试时复用历史成功接口
- 页面操作时及时发现失败接口
- 把一次测试过程产出成结构化报告

不适合的场景：

- 复杂签名、nonce、时间戳强依赖接口的稳定回放
- 文件上传下载
- WebSocket / SSE / 长连接协议分析
- 需要服务端统一存储和团队协作的场景

## 当前状态

当前仓库已经有一个可运行的 MVP userscript，主链路已打通：

- 自动捕获 `fetch` / `XMLHttpRequest`
- 默认按 `HTTP 状态 + 常见业务字段` 判定 `success / fail / unknown`
- 使用 `IndexedDB` 持久化保存会话、记录、模板和回放报告
- 提供右下角悬浮入口和侧边面板
- 支持查看成功记录、失败记录和接口详情
- 支持成功记录模板化
- 支持单条和批量模板回放
- 支持导出 `JSON` / `HTML` 报告
- 默认对 `authorization`、`cookie`、`token` 等字段脱敏
- 默认限制 `prod` / `production` 域名回放

## 核心能力

### 1. 自动采集

- 劫持页面中的 `window.fetch`
- 劫持 `XMLHttpRequest`
- 自动记录请求和响应摘要
- 默认只采集命中 `/api/` 的请求
- 默认过滤健康检查、日志、埋点等常见噪声接口

### 2. 成功失败判定

当前默认规则：

- HTTP 非 `2xx` 默认判为 `fail`
- JSON 中 `body.success === true` 判为 `success`
- JSON 中 `body.success === false` 判为 `fail`
- JSON 中 `body.code === 0` 判为 `success`
- JSON 中 `body.code !== 0` 判为 `fail`
- 其他情况判为 `unknown`

同时支持后续按接口规则覆盖默认判定逻辑。

### 3. 本地持久化

脚本使用浏览器本地存储：

- `IndexedDB`：保存会话、记录、模板、回放报告
- `GM_setValue`：保存轻量配置

这意味着：

- 刷新页面后历史数据仍然存在
- 不需要依赖本地文件持续写入
- 查询、筛选、模板管理更容易

### 4. 模板化与回放

成功记录可以保存成模板，当前支持：

- 单条接口回放
- 多条模板批量回放
- 基于 `cookie` / `localStorage` / `sessionStorage` / 手工输入 的变量补齐
- 对高风险接口做回放限制

### 5. UI 面板

当前 UI 由右下角悬浮入口 + 右侧面板组成，包含 5 个页签：

- `当前会话`
- `成功记录`
- `失败记录`
- `回放中心`
- `报告`

### 6. 报告导出

当前支持导出：

- `JSON`
- `HTML`

报告中会汇总：

- 会话信息
- 成功 / 失败 / 未知统计
- 失败接口摘要
- 回放结果摘要

## 目录结构

```text
tampermonkey-api-recorder/
  dist/
    tampermonkey-api-recorder.user.js
  docs/
    MVP功能清单.md
    UI交互草图.md
    接口规则设计.md
    油猴脚本技术设计.md
  src/
    tampermonkey-api-recorder.user.js
  README.md
  方案拆解.md
```

说明：

- `src/`：源码
- `dist/`：可直接安装到 Tampermonkey 的脚本
- `docs/`：方案、规则、技术设计、UI 草图等文档

## 安装方式

### 方式一：直接安装 `dist` 脚本

1. 打开 Tampermonkey
2. 新建脚本
3. 用 `dist/tampermonkey-api-recorder.user.js` 的内容覆盖默认脚本
4. 保存
5. 刷新目标页面

### 方式二：使用 `src` 作为开发版本

如果你还在迭代代码，可以直接把 `src/tampermonkey-api-recorder.user.js` 的内容贴进 Tampermonkey 中测试。

## 使用方式

### 1. 启用脚本

安装脚本后，打开你的测试页面。

页面右下角会出现一个悬浮入口，显示：

- 当前记录总数
- 当前失败数
- 当前未知数

### 2. 正常执行页面操作

像平时测试一样点击页面。

脚本会自动：

- 捕获命中的接口
- 记录请求 / 响应摘要
- 判定成功 / 失败 / 未知
- 在失败时弹出 toast 提示

### 3. 查看会话和记录

点击右下角悬浮入口后，可在面板中查看：

- 当前会话统计
- 成功记录
- 失败记录
- 每条记录的详情

### 4. 生成模板

在成功记录中点击 `生成模板`，可把当前请求保存成可回放模板。

### 5. 执行回放

在 `回放中心` 中可以：

- 回放单条模板
- 选择多条模板批量回放
- 检查模板变量是否齐全

### 6. 导出报告

在 `报告` 页签中可以导出：

- `JSON`
- `HTML`

## 默认行为

当前默认配置包括：

- 只采集路径命中 `/api/` 的请求
- 默认排除心跳、日志、埋点、健康检查等噪声请求
- 默认过滤 `text/html` 响应
- 默认对敏感字段脱敏
- 默认屏蔽域名包含 `prod` / `production` 的回放
- 默认将 `GET/HEAD/OPTIONS` 视为 `safe`
- 默认将 `POST/PUT/PATCH` 视为 `warning`
- 默认将 `DELETE` 视为 `danger`

## 临时调试接口

脚本在页面上挂了一个全局对象：

```js
window.__TM_API_RECORDER__
```

可用方法：

```js
window.__TM_API_RECORDER__.getConfig()

window.__TM_API_RECORDER__.setConfig({
  capture: {
    include: [{ type: 'prefix', pathname: '/gateway/' }]
  }
})

window.__TM_API_RECORDER__.getState()
```

### `getConfig()`

读取当前脚本配置。

### `setConfig(config)`

覆盖当前配置并持久化保存。

示例：

```js
window.__TM_API_RECORDER__.setConfig({
  enabled: true,
  capture: {
    include: [{ type: 'prefix', pathname: '/gateway/' }],
    exclude: [{ type: 'exact', pathname: '/gateway/health' }]
  },
  replay: {
    blockedHostKeywords: ['prod', 'production', 'online']
  }
})
```

### `getState()`

读取当前内存中的运行态数据，包括：

- `currentSession`
- `records`
- `templates`
- `replayReports`

## 数据存储说明

当前脚本主要使用浏览器本地存储，不依赖后端服务。

### 会话

每次打开页面后会创建一个会话，记录：

- 会话 ID
- 页面地址
- 开始时间
- 最近活动时间
- 成功 / 失败 / 未知统计

### 记录

每条命中的接口会保存：

- 方法
- 路径
- 请求头
- 请求体
- 响应头
- 响应体摘要
- 分类结果
- 判定原因

### 模板

模板来源于成功记录，保存：

- `method`
- `pathname`
- `headers`
- `query`
- `body`
- 动态变量规则
- 风险等级

### 回放报告

每次回放后会保存：

- 回放类型
- 开始 / 结束时间
- success / fail / skipped 数量
- 每条模板的执行结果

## 风险与限制

### 当前已知限制

- 第一版没有可视化配置编辑器
- 模板动态变量目前主要自动处理鉴权类 header
- 强依赖签名、nonce、时间戳的接口回放可能失败
- 文件上传、WebSocket、复杂 iframe 场景还没做
- 当前规则系统还没有可视化管理页

### 风险说明

- 回放可能产生测试数据副作用
- 某些写接口不能重复回放
- 某些业务接口依赖前序接口返回值
- 若页面自己改写了 `fetch/XHR`，可能需要做兼容修正

## 后续计划

下一阶段优先考虑：

- 增强接口规则配置能力
- 增强模板动态变量提取能力
- 完善脱敏策略
- 增加更稳定的 UI 交互和筛选能力
- 增加默认内置规则集
- 增强复杂回放场景支持

## 相关文档

- [方案拆解.md](./方案拆解.md)
- [MVP功能清单.md](./docs/MVP功能清单.md)
- [油猴脚本技术设计.md](./docs/油猴脚本技术设计.md)
- [接口规则设计.md](./docs/接口规则设计.md)
- [UI交互草图.md](./docs/UI交互草图.md)

## 当前主文件

- 开发源码：[src/tampermonkey-api-recorder.user.js](./src/tampermonkey-api-recorder.user.js)
- 可安装脚本：[dist/tampermonkey-api-recorder.user.js](./dist/tampermonkey-api-recorder.user.js)
