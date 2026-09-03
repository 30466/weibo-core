---
name: weibo-core
description: Operate the local weibo-core CLI to log in to Weibo, resolve account names or UIDs, crawl/export posts, and process TXT account lists. Use this skill whenever the user asks to抓取微博账号帖子、按微博名称或 UID 导出、批量同步微博账号、检查微博登录，或处理 weibo-core。登录默认使用纯 HTTP 二维码；二维码持续失败时，本技能必须让用户选择是否使用当前 Agent 已有的浏览器自动化能力作为备用方案。
---

# weibo-core

在项目根目录执行命令。这个 CLI 的帖子抓取始终使用 HTTP API；浏览器只可能用于取得登录 Cookie。

## 开始前

1. 检查 Node.js 版本满足 20+。
2. 已安装依赖时直接复用；缺少 `node_modules` 时运行 `npm install`。源码或依赖发生变化后运行 `npm run build`。
3. 运行 `node bin/weibo.js status`。凭证有效时直接抓取，不要重复登录。

## 登录决策

1. 没有有效凭证时，默认运行 `node bin/weibo.js login`。它使用纯 HTTP Passport 二维码，不启动浏览器，并在新二维码生成后等待同步窗口再展示。
2. 如果二维码连续失效、超时或用户明确要求浏览器登录，先向用户说明并让其选择：
   - 重试纯 HTTP 二维码；
   - 使用浏览器备用登录。
3. 未经用户选择，不要自行启动可见浏览器。只有用户明确要求退出登录时才运行 `node bin/weibo.js logout`。

## 浏览器备用登录

浏览器流程由当前 AI Agent 自己已有的工具完成，项目不绑定 Playwright、Puppeteer 或任何浏览器控制库。

1. 检查当前环境已有的浏览器自动化能力，例如 agent-browser、已连接的 Chrome/in-app Browser、现成的 Playwright CLI，或用户指定的工具。
2. 检查是否已有可用 Chrome/Chromium 二进制。不要因为缺少工具或二进制而自动安装或下载；告诉用户缺少什么，并让用户决定。
3. 使用可见、隔离的浏览器会话打开 `https://weibo.com/login.php`，让用户在窗口中完成官方登录。优先使用隔离会话，不读取用户日常浏览器的 Cookie 数据库。
4. 登录完成后，通过浏览器工具或 CDP 获取包含 HttpOnly 项的 Cookie。只收集微博登录所需域：`.weibo.com`、`.weibo.cn`、`.sina.com.cn`；确认至少包含 `SUB`。
5. 不要在对话或日志中打印 Cookie。把拼成 `name=value; name=value` 的完整 Cookie 直接传给以下命令的标准输入：

   ```bash
   node bin/weibo.js import-cookie
   ```

   该命令会在线校验 Cookie，并以 `0600` 权限保存到 `.cache/weibo/credential.json`。
6. 保存成功后关闭隔离浏览器，再运行 `node bin/weibo.js status`。验证有效后才开始抓取。

如果当前浏览器工具无法安全取得 HttpOnly Cookie，就停止并说明限制，不要改用 `document.cookie` 冒充完整凭证。

## 抓取命令

- 名称查 UID：`node bin/weibo.js lookup <账号名称>`
- 预览：`node bin/weibo.js list <UID> --limit 30`
- 按名称导出：`node bin/weibo.js export --name <账号名称>`
- 按 UID 导出：`node bin/weibo.js export <UID>`
- TXT 批量导出：`node bin/weibo.js sync <文件路径>`

TXT 每行可写数字 UID、微博主页 URL 或账号名称；空行、`#` 注释和重复项会自动处理。

默认抓取依次完整枚举高级搜索 `searchProfile` 和旧时间线 `mymblog`，再按帖子 ID 求并集；不要只用其中一个接口冒充全集，也不要并行交错同一账号的两个分页源。目标账号自己的转发必须保留；顶层作者 UID 不等于目标账号的活动卡、推荐项或占位对象会被排除。

两个接口的结果不是稳定的包含关系：同一账号在不同运行中，报告总数、实际返回条数和独有帖子都可能变化，后一次不保证大于或等于前一次。遇到这种波动时保留两个顺序抓取结果并按帖子 ID 去重，不要据单次运行推断某个接口永远更全。

批量 `sync` 会在正式抓取前先读取每个已解析账号的 `statuses_count`，仅作为规模估计并按从多到少排序；该数字不是最终帖子数，预检失败的账号排在末尾并在导出时重试。排序不改变账号并发、两个接口的顺序或并集规则。

默认导出会持续请求后续页直至两个数据源自然耗尽。不要用浏览器滚动帖子列表，也不要把使用 `--limit`、`--max-pages` 或中途失败的结果描述成“全部帖子”。

终端提示“已自动排除非本人/无作者占位”表示列表接口混入了顶层作者 UID 不等于目标账号，或没有有效作者 UID 的对象；常见来源是“她赞过/她评论过”的活动卡、推荐/广告卡片，以及删除或私密后留下的空占位。这不是请求失败，也不是正文详情失败。目标账号自己的原创和转发仍会保留；同一对象若被两个分页源各返回一次，过滤计数可能各计一次。

## 抓取参数保护

真实批量测试中，已观察到的 414 全部来自旧时间线 `/ajax/statuses/mymblog` 的大账号分页；高级搜索 `searchProfile` 和正文详情 `longtext` 没有出现同类失败。三个阶段使用独立客户端，自动大账号保护只作用于旧时间线。旧时间线必须先以并发 1 从第 1 页起完成所有资料数超过 1200 条的大账号，之后才放行普通账号并发 2；不要让普通账号提前与超量阶段混跑。

分析性能日志时，账号完成行的“用时”从该账号 worker 开始计时，包含等待旧时间线阶段/槽位的时间；并发账号的计时区间互相重叠，不能相加。判断整批耗时以末尾“总用时”为准，阶段细节以高级搜索、旧时间线和正文详情的开始/完成行判断。

除非用户明确要求进行新的对照实验，Agent 最好不要修改这些参数，也不要主动附加 `--concurrency`、`--feed-concurrency`、`--detail-concurrency`、`--delay` 或 `--safe` 覆盖默认值。实测缩短或取消暂停、提高旧时间线并发、统一全局降速，或者改变重试等待，都可能增加 414 重试、显著拖慢整批，甚至导致抓取失败。完整试验过程和取值依据见 `README.md` 的“为什么旧时间线使用不同参数”和“控制变量记录”。

只有用户明确要求整次命令全程采用保守参数时才使用 `--safe`。遇到 414、418、429 等可重试响应时，让 CLI 保留进度并自动重试当前页；等待期间不要另启抓取进程。

当同一页第 3 次仍失败时，先运行 `status` 区分登录失效与风控；凭证仍有效时稍后单独重试失败账号。项目本身不配置或管理代理；若用户的 VPN 已接管系统流量，CLI 保持默认网络请求即可。不要将仅自己可见/粉丝可见造成的帖子数缺口解释为 HTTP 414。

做长时间性能对照时必须保持 macOS 唤醒（可由 Agent 用 `caffeinate -i` 包裹测试命令）。系统睡眠时进程会暂停，唤醒后虽能续跑，但墙钟耗时会计入睡眠时间，不能用来比较参数。

## 输出边界

- `export` 和 `sync` 默认写入 `data/{账号名称}/{uid}.json` 与 `.csv`。
- 时间字段遵循“绝对时刻存储、北京时间展示”：接口原始时间必须带明确时区，`createdAt`、`updatedAt` 保留 UTC ISO 8601；不要为了下游页面展示而重写为无时区的北京时间字符串。CLI 会显式显示北京时间，高级搜索 `endtime` 固定使用北京时间次日零点。
- 下游 fansite 合并脚本应原样保留 `createdAt`，只按绝对时刻排序；06:00 归档只属于录播和切片，不适用于微博。
- JSON 的完整键名、类型和含义以 README 的“JSON 键名完整对照”为准；`textHtml`、`textComplete` 仅供运行时正文补全使用，不会写入导出 JSON。
- 输出以稳定帖子 `url` 为媒体入口，不保存会过期的图片或音视频 CDN 直链。
- `crawl.exhausted=true` 才表示两个分页源都自然耗尽；检查 `sourceStats`、`stoppedReason` 和 `filteredOutCount` 后再汇报覆盖情况。
- 本项目不实现媒体下载；不要擅自扩展为下载器。

## 测试与本地资料

- `npm test` 运行公开的 core 回归测试和时间测试，全部使用虚构账号、接口响应和固定绝对时刻，不联网；修改时间解析、显示或搜索截止边界后，另运行 `npm run test:time`，确认 `Asia/Shanghai`、`UTC`、`America/New_York` 三种环境结果一致。
- `test/local/` 可保存维护者自己的真实标识测试副本，`test-output/` 与 `data/` 可保存联网调研结果；三者均被 Git 忽略。不要展示、提交或把其中的真实账号资料复制进公开测试和文档。
- 修改源码或公开测试后运行 `npm test`。只有在任务明确要求真实接口验证且登录凭证有效时，才运行联网抓取。

## 安全边界

- 不展示、回显或提交 `.cache/weibo/credential.json`。
- 不提交 `.env`、`data/`、`test-output/`、`test/local/` 或本地账号 TXT。
- 不覆盖仍然有效的凭证。
- 不自动安装浏览器控制库或下载浏览器二进制。
- 浏览器登录结束后关闭隔离会话；帖子抓取继续使用 CLI 的 HTTP API。
- 本项目只抓取帖子索引和文本元数据，不保存临时媒体直链，也不实现图片、音频或视频下载。需要查看媒体时返回帖子 `url`。
