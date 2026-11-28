# BOT THK GraphQL 后端迁移路线图

> 历史审查基线：`b8e75c6`。本文是迁移计划和逐批验证记录，不是实时状态面板；当前实现状态以代码、CI 和活跃 issue 为准。
> 范围：初始审查涵盖 TypeScript 源码、GraphQL SDL、依赖/锁文件、TypeScript/ESLint、Docker/Compose 配置与开放审计 issue；后续每批迁移在对应段落追加实际改动与验证证据。
> 证据边界：依赖 metadata/audit 与本地 typecheck、lint、unit/runtime、build 各自证明的范围不同；未运行的 MongoDB/Docker/线上验证不会标记为通过。

## 1. 执行摘要

这是一个由 Express + Apollo Server 3 + TypeGraphQL + Mongoose/Typegoose 组成的 GraphQL 后端，同时包含 SSE 订阅、认证、内容/社交关系、私信和 Cloudinary/Puppeteer 图片能力。业务面覆盖较完整，但目前安全、授权、一致性、可观测性和工程验证存在多个高风险缺口；不能把“依赖升到最新”当成单独的版本更新任务，必须先固定 API/数据契约并建立测试与回滚能力，再按业务域分阶段迁移。

建议顺序是：**P0 安全止血 → 建立 CI/测试与运行时基线 → GraphQL/HTTP 迁移 spike → 数据/服务层重整 → 按业务域切片迁移 → 灰度与清理**。

### 早期迁移批次记录（历史摘要）

初始迁移期间已落地第一批止血与工程基线改动：修正匿名用户通过 `authChecker`、刷新/登录/忘记密码日志泄漏、使用 scrypt 建立新密码哈希并在旧 HMAC-SHA1 登录成功后渐进升级、密码重置改为短时签名 token 并在一次成功后失效、文章写操作所有权检查、会话读写/消息发送成员检查及已读字段修正；搜索用户/用户资料/关注列表改用白名单 DTO，不再返回邮箱和关系 ID；启动时 Mongo 连接失败会失败退出，加入 `/healthz`/`/readyz` 与 SIGINT/SIGTERM 停机，生产禁用内联 trace/landing page/schema 文件写入，修复 Docker 生产启动路径与 Compose 配置，并加入 CI、README、env 示例和 6 个单元/schema 测试。此处仅记录早期迁移批次，具体现状请以当前代码与 CI 为准。

本轮订阅授权批次在通知、消息与会话 SSE 订阅上要求认证用户，并只依据服务端生成的事件受众/参与者 ID 投递，不再依赖客户端传入的关注者 ID、用户名或会话 ID 作为授权凭据；消息还要求订阅会话 ID 与事件会话 ID 一致。新增 `conversationRemoved`，被移除成员只获得会话 ID 元数据，其余会话更新只投递给操作后仍在会话中的用户；原有 `blogPublished(followingIds:)` 与 `userFollowed(name:)` 参数保留以维持 schema 兼容。新增确定性授权 helper 与运行时 schema 字段测试；本地 `yarn typecheck`、`yarn lint`、`yarn test`（15 项）、`yarn build`、`git diff --check` 全部通过。尚未执行真实 MongoDB 集成或端到端 SSE 验证，因此此批次不能视为完成完整运行环境门禁。

后续 schema 隐私加固从运行时 `User` GraphQL 类型移除了 `resetPasswordLink`，但保留 Typegoose 持久化字段以兼容已有数据；测试断言运行时 schema 不再暴露该字段。认证补充批次改为以 `tokenVersion` 条件原子递增来消费 refresh token，使同一 token 在并发重放下最多成功一次；同时统一字符串/ObjectId 用户 ID 比较，修复 self-follow 检查因引用类型不同而失效的问题。确定性回归测试覆盖并发 refresh 与 ID 归一化。最新本地 typecheck、lint、17 项 test、build 与 `git diff --check` 均通过。其他嵌套 GraphQL 类型的用户字段白名单审计仍待完成。

早期审查列出的其他后续待办包括 refresh token 改为仅经 HttpOnly cookie 流转（当前仍保留旧 GraphQL 参数/响应以待客户端兼容迁移）、所有嵌套 GraphQL 类型的用户字段白名单审计（搜索/资料/关注查询已使用脱敏 DTO，`resetPasswordLink` 已从 `User` GraphQL 类型移除，其余嵌套字段待审计）、限流/幂等、媒体 SSRF worker、关系写入事务一致性、分页/DataLoader、完整 Mongo 集成测试与数据库对账。Docker daemon 在当前执行环境不可用，因此 Compose/Docker 构建已配置 CI 校验但未在本地执行。

本仓库中的 AI coding-agent 使用方式仅由根目录 `AGENTS.md` 与 [`AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md) 约定。这些是供开发代理阅读的协作说明，不构成后端运行时组件，也不代表需要在服务中部署 Agent。

### 当前结构与能力盘点

| 模块 | 现有实现 | 迁移时必须保持/补齐 |
| --- | --- | --- |
| HTTP / GraphQL | `src/server.ts`：Express、Apollo Server 3、GraphQL query complexity、健康根路由 | HTTP 生命周期、统一错误格式、生产安全默认值、限流、readiness/liveness、graceful shutdown、复杂度与深度限制 |
| Schema / 授权 | TypeGraphQL decorators、`createSchema`、静态 SDL 文件、`authChecker`、HTTP/SSE 两套上下文 | SDL 契约兼容、角色与对象所有权矩阵、SSE/HTTP 同源身份规则、schema diff 门禁 |
| 账户与身份 | 注册、登录、刷新、登出、忘记/重置密码、关注用户 | 认证/授权一致性、密码渐进迁移、refresh rotation/revocation、隐私字段隔离、抗暴力破解 |
| 内容 | Blog、Category、Tag、搜索、草稿、点赞、评论/回复、用户文章 | 所有权校验、草稿过滤、分页、稳定排序、原子/幂等关系更新、slug 唯一性 |
| 私信 | Conversation、Participant、Message、read marker、GraphQL SSE subscription | 成员权限、读写一致性、消息游标分页、可靠订阅/断线重连、事件顺序与重复处理 |
| 媒体 | Cloudinary SDK；Puppeteer 截图 handler/router 存在但 server 挂载已注释 | SSRF 防护、隔离 worker、浏览器资源/并发配额、临时文件可靠清理、能力是否保留的产品决策 |
| 运维与工程 | Dockerfile、Compose、Yarn v1 锁文件、TypeScript build | 可复现构建、非 root、健康检查、镜像体积/漏洞扫描、env schema、CI、日志/指标/追踪 |

## 2. 主要审查发现

以下条目对应已有开放 issue；本次复核发现的重复票与治理问题另列在 §3。具体根因、代码位置和建议验收请以每个 issue 正文为准。

### P0 / P1：先处理再迁移

- **认证与授权**：`authChecker` 存在匿名/角色判断风险；文章更新/删除、会话成员更新、已读操作的身份/所有权检查不充分；重置密码和邮件发送失败路径存在敏感令牌风险；刷新令牌未按安全生命周期轮换。见 #2、#3、#10–#14、#18。
- **凭证与隐私**：密码使用 HMAC-SHA1 和非加密安全盐；登录 access token、用户/请求对象等内容写入 console；用户查询可能暴露邮箱/关系信息；搜索输入存在正则注入风险。见 #1、#7–#9、#16–#17、#28。
- **媒体 SSRF**：Puppeteer 处理用户给出的 URL，具有内网/本地资源访问面；目前路由未挂载不代表代码路径可以忽略，若重新启用须先完成隔离和目标限制。见 #4、#29。
- **运行与发布风险**：生产 Docker 最终层的 NODE_ENV/启动脚本/构建依赖不匹配；Compose 配置存在阻断启动问题；MongoDB 连接失败仍继续启动；无 CI 和回归测试。见 #15、#20、#23、#25。
- **请求滥用与数据完整性**：写操作缺少限流、配额/幂等；关系双写容易并发丢更新；所有列表和会话消息缺有效分页；草稿可见性规则分散。见 #5–#6、#19、#21–#22、#26。

### P2：架构、质量与运维

- Redis PubSub 未启用、订阅授权/数据保留策略未定；SSE context 与 GraphQL 主链路不一致。见 #30、#46。
- autopopulate 造成不可控查询展开，DataLoader 尚未落地；关系/会话数据重复存储。见 #27、#38、#45。
- 手写 SDL 与运行时 schema 可能漂移；复杂度门限和错误语义不统一；对象 ID、已读字段、slug 唯一约束等有明确缺陷。见 #31–#37、#47。
- 环境变量无模板/校验且 dotenv 多次加载；依赖含 EOL、幻影/未用依赖；TS 断言过多；lint 缺少有效约束；没有健康探针、优雅停机和可观测性。见 #39–#44。

### 明确存在的跟踪器治理问题

#1/#17（密码哈希）、#4/#29（SSRF）、#5/#26（分页）、#8/#28（令牌日志）主题重叠。应先判断是否是相同根因，再按 #50 合并并保留交叉引用；不要为追求“issue 数量”复制票据。

## 3. GitHub issue 执行清单

- **已有审计**：#1–#47，覆盖本次列出的安全、业务、数据、运维、工程和 CI 发现。
- **迁移总控**：[#48 后端整体迁移与依赖现代化](https://github.com/BrainEno/bot-thk-gqlserver/issues/48)。覆盖全部业务域、兼容性 spike、阶段验收和回滚策略。
- **Issue 治理**：[#50 审计 issue 去重与证据/优先级校准](https://github.com/BrainEno/bot-thk-gqlserver/issues/50)。

本次没有为 #1–#47 已记录的问题重复开票。issue 的“实测”描述应在执行修复时附可重现证据；若不能复现，应在治理时改为“静态判断”，不可把历史描述当成此轮已经运行验证。

## 4. 依赖现代化策略

截至 2026-11-25 的 npm registry 查询结果中，Apollo Server latest 为 5.5.2、Express 5.3.0、GraphQL 17.1.0、Mongoose 9.13.1、Typegoose 13.5.0、TypeScript 7.0.2、Puppeteer 25.18.1；TypeGraphQL latest tag 是 `2.0.0-rc.3`。这是 registry 的 latest 信息，不代表这些版本彼此兼容或适合当前 Node 22/24 运行环境。

**当前依赖迁移状态（PR #61 已合并）：** Apollo Server 5 + Express 5、GraphQL 16.15、TypeGraphQL `2.0.0-rc.3`、TypeScript 6、Puppeteer 25，以及 Mongoose 9.13.1 + Typegoose 13.5.0 已纳入代码；用户明确接受 TypeGraphQL RC。Mongoose 9 / Typegoose 13 的迁移通过将实体 `_id` 类型改为 `Types.ObjectId`、将 populated refs 规范化到 ObjectId，并改用模型级更新解决了严格查询和文档方法类型问题，没有用宽泛 `any` 压制编译错误。Typegoose 13.5.0 声明的 Mongoose peer 仍是 `~9.9.5`；为包含 Mongoose 9.11.4 之后的安全修复，本项目固定在 9.13.1，并已通过 typecheck、lint、11 项 unit/runtime 测试（含 Apollo Server 对 TypeGraphQL schema 的 query 执行与日志敏感字段脱敏）、build 和 frozen-lockfile install，但仍需有真实 MongoDB 的集成验证。

GraphQL Scalars 2.0.1 是 TypeGraphQL RC3 声明的必需 peer；depcheck 因为本项目没有直接调用其导出而误报“未使用”，不能据此删除。2.0.1 是 PhoneNumber 标量 ReDoS advisory 的修复版本，但超出 TypeGraphQL `^1.25.0` peer 范围；保留修复版并记录该风险。为消除 GraphQL Tools mergeDeep 原型污染漏洞，本项目解析到 `@graphql-tools/utils` 12.1.0（Apollo Server 5.5.2 声明的上限为 `<12.0.2`），仍有 Yarn range warning；Apollo/TypeGraphQL schema execution smoke test 与项目测试通过。`nodemon` + 受漏洞影响的 `minimatch` 已移除，开发 watch 改用 Node 22 原生 `--watch`，避免不兼容 major resolution。临时以 npm overrides 模拟 Yarn resolution 对锁定依赖执行 npm audit，结果为 0 项；Yarn audit 命令仍因 TLS 断连不可用。GraphQL 17 仍不符合 Apollo Server 5 / TypeGraphQL RC3 的 peer 范围。TypeScript 7 暂缓：当前 `@typescript-eslint` 只声明支持 TypeScript `<6.1.0`。`@types/node` 保持与 CI/运行时 Node 22/24 对齐，不跟随 Node 26 类型版本。

本轮把生产日志改为 stdout JSON、开发环境使用仅在 devDependency 中的 pino-pretty，加入 HTTP request ID 与 GraphQL operation latency/error-count 日志；移除解析器中的 console 调试输出、静态依赖图发现的未引用 schemas/error helper/interface/utility 文件及实体中未调用的 DB 查询方法（解除 entity→models 循环依赖；依赖图仍有 6 组实体/DTO 双向类型引用，字段类型使用懒解析并已通过 schema 构建测试，后续可随 DTO 分层评估拆分），避免遗留无效抽象和打印用户/关系标识。静态扫描确认 `class-transformer` 仅剩未实际执行的 `@Exclude` 注解、没有任何转换调用，因此一并移除依赖和无效注解；扫描也确认生产依赖无未引用项、无缺失依赖（graphql-scalars 保留为 TypeGraphQL 必需 peer）。`mongodb` 直接引用改为由项目直接依赖 Mongoose 暴露的 `Types.ObjectId`。本地断点调试入口仍为 `yarn debug` 与 VS Code launch；服务完整启动仍需要 MongoDB。

| 当前项/风险 | 候选方向 | 决策门槛 |
| --- | --- | --- |
| Apollo Server 3（EOL）和 Express 4 | 已迁移到 Apollo Server 5 + Express 5 adapter（PR #61） | 保留 GraphQL 16 peer 范围；仍需在有 MongoDB 的环境验证完整 HTTP/SSE 启动与客户端契约 |
| TypeGraphQL 1.1 + GraphQL 15 | 已迁移到 TypeGraphQL `2.0.0-rc.3` + GraphQL 16.15 + GraphQL Scalars 2.0.1 | TypeGraphQL RC 与 Scalars 2 存在 peer-range mismatch；已通过 schema/build/unit 验证并用于安全修复，GraphQL 17 仍不兼容 |
| Express 4 / TypeScript 4 / Node 18 镜像 | Express 5、TypeScript 6、Node 22/24 CI | TypeScript 7 等待 `@typescript-eslint` peer 兼容；验证目标 Node 矩阵与启动配置 |
| Mongoose 8 + Typegoose 12 | 已升级到 Mongoose 9.13.1 + Typegoose 13.5.0（Typegoose peer 元数据仍限 `~9.9.5`） | 用 9.13.1 纳入已修复的 Mongoose 安全公告；保持 ObjectId/ref 类型规范，后续补真实 MongoDB integration 覆盖 populate、transaction、index 和查询行为 |
| `mongoose-autopopulate` | 显式 populate + request-scoped DataLoader | 先有查询基线；防止循环 populate、跨用户缓存和 N+1；建立列表分页/投影/索引 |
| `shortid` | 首选 Node 内建 `crypto.randomUUID()`；若业务必须短 ID，再评估维护活跃且模块格式兼容的库 | 标识符是否安全敏感、数据库长度/索引、URL 和客户端兼容 |
| HMAC-SHA1 密码存储；`bcrypt` 已安装但未使用 | 首选 Argon2id；在原生依赖和部署支持不合适时基准 bcrypt | 渐进 rehash：旧格式只作登录校验，通过后立即升级；禁止明文导出/批量解密 |
| `graphql-redis-subscriptions` / 未启用 PubSub | 根据可靠性需求选择短暂 PubSub，或 outbox + Redis Streams/维护中的队列 | 定义掉线、重放、保留、顺序、幂等和背压；可靠业务事件不能只依赖易丢失的瞬时 PubSub |
| `@types/graphql`、TypeDI、rimraf、未用 SendGrid/其他依赖、幽灵包 | 逐项移除、替换或实际接线；`pino-pretty` 放开发依赖 | 静态引用 + clean frozen install + build/test；不只看直接依赖，也查传递依赖 |
| Yarn classic lockfile、依赖策略不统一 | 选定单一包管理器、pin 运行时/包管理器并由 CI 验证锁文件 | 选型前评估现有 Docker/维护成本；自动化更新须分组、限速并有测试，不能无审查自动合并主版本 |

依赖升级流程：导出当前依赖/SBOM → 维护状态与安全公告核对 → peer/engine 矩阵 → 每次一个技术层主版本 → clean install → typecheck/lint/unit/integration/build/container → staging soak → 删除兼容层。任何外部服务 SDK（Cloudinary/邮件）、MongoDB driver、GraphQL subscription transport 和 schema 工具都必须纳入矩阵。

## 5. 迁移阶段与上线门禁

### 阶段 0 — 安全止血与契约冻结

处理 P0/P1 权限和秘密泄漏；暂停/关闭未受保护的能力；生成 resolver × 角色 × 所有权矩阵；盘点全部 GraphQL query/mutation/subscription、输入输出、错误码、客户端使用和数据库集合/索引。安全缺陷优先按 #1–#22 等 issue 拆分实施，不等待框架升级。

**门禁**：匿名/普通用户/作者/管理员权限测试全部可执行；所有秘密从日志与 API 响应剔除；危险截图能力已关闭或有 SSRF 隔离。

### 阶段 1 — 工程与运行基线

修复 Docker/Compose 启动；补 README、环境变量 schema 与 `.env.example`；固定 Node LTS/包管理器；启用 CI：frozen install、格式/lint、严格 typecheck、unit、Mongo integration、build、Docker build/run/healthcheck、依赖扫描。引入稳定的 error boundary、结构化日志和健康探针。

**门禁**：新环境可一条文档化命令启动；CI 阻止不通过的 PR；main 不依赖本机依赖 hoist。

### 阶段 2 — GraphQL/HTTP 兼容 spike

建立当前 API 合约快照与 query fixtures。单独验证 Apollo 5 + Express adapter（以及 GraphQL Yoga 备选）能否保持 cookie/CORS、错误格式、复杂度限制、TypeGraphQL resolver、`graphql-sse`、graceful shutdown 与生产 introspection 策略。若 TypeGraphQL 稳定兼容路径不成立，ADR 决定迁 Pothos 或 SDL；再按 resolver 域搬迁，不一次性重写。

**门禁**：已有客户端 operation fixtures 全部通过；schema diff 经过批准；SSE 可鉴权、断连、重连和停机。

### 阶段 3 — 数据/服务层与业务域

先按 user/auth、blog/content、comment/like/follow、conversation/message、notification/subscription、media 的顺序建立 use-case/service 边界。去掉跨域直接写 Model；统一输入验证、权限策略、错误映射、事务/原子操作、幂等键和审计事件。为高频查询建立分页、投影、索引和 DataLoader；逐个迁移，保留旧 API adapter 直到调用方完成切换。

数据迁移只做向前兼容 schema/additive 变更；建立回填脚本、dry run、计数/抽样对账、重复执行安全和 rollback/forward-fix 手册。Mongo 多文档事务仅在集群配置支持时使用；单文档可用原子操作时优先原子更新。旧密码采用成功登录时 rehash。

**门禁**：每个业务域有功能/权限/并发/失败恢复测试；数据库行数与关键关系对账通过；旧写入路径已封闭后才切换读路径。

### 阶段 4 — 性能、运维、灰度与下线旧栈

对查询耗时、复杂度、DB 调用数、SSE 并发、内存、错误率和邮件/Cloudinary失败建基线；限制 webhook/截图/GraphQL 资源消耗；按 1% → 10% → 50% → 100% 灰度，保留快速回滚开关。删除旧 resolver、重复 SDL、旧依赖和过期迁移脚本；生成 SBOM 与运行手册。

**最终门禁**：SLO/告警有效、回滚演练通过、无 EOL/未批准 RC 生产依赖、依赖漏洞与许可检查有明确豁免记录。

## 6. AI coding-agent 协作约定

仓库级编码要求见 [`AGENTS.md`](../AGENTS.md)，多代理任务分解、文件所有权、独立审查、验证和交接流程见 [`AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md)，可复用任务单见 [`AGENT_TASK_TEMPLATE.md`](./AGENT_TASK_TEMPLATE.md)。这些文档只规范开发代理如何协助维护本后端，不在应用中运行 Agent，不新增模型/provider、AgentRuntime、Agent 工具、Agent 专用持久化或 Agent API。任何未来 AI 产品功能都必须由单独、明确批准的产品需求和安全设计开启。

## 7. 下一步建议

1. 先对 #1–#47 做 P0/P1 排序和 #50 去重，不要以框架迁移掩盖现有漏洞。
2. 将 #23 作为第一批实现：CI/基础测试和可工作的容器启动路径；然后补核心权限回归。
3. 由 #48 承接兼容 spike、迁移 ADR、API/数据契约和分阶段 PR；依赖升级拆成可回滚小步。
