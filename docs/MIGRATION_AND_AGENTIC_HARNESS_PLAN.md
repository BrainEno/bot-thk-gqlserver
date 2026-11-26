# 后端整体迁移与 Agentic Harness 基座路线图

> 审查基线：`b8e75c6`（当前分支 `arena/afccf877-bot-thk-gqlserver`）。
> 范围：本次审阅了已跟踪的 TypeScript 源码、GraphQL SDL、依赖/锁文件、TypeScript/ESLint、Docker/Compose 配置，以及当前 GitHub 开放审计 issue。未改动业务实现。
> 证据边界：仓库没有测试、没有 CI，也没有安装依赖目录；因此本次不能把静态判断冒称为完整的运行时验证。依赖候选版本仅通过 npm registry 查询，升级兼容性须由迁移 spike 和 CI 证明。

## 1. 执行摘要

这是一个由 Express + Apollo Server 3 + TypeGraphQL + Mongoose/Typegoose 组成的 GraphQL 后端，同时包含 SSE 订阅、认证、内容/社交关系、私信和 Cloudinary/Puppeteer 图片能力。业务面覆盖较完整，但目前安全、授权、一致性、可观测性和工程验证存在多个高风险缺口；不能把“依赖升到最新”当成单独的版本更新任务，必须先固定 API/数据契约并建立测试与回滚能力，再按业务域分阶段迁移。

建议顺序是：**P0 安全止血 → 建立 CI/测试与运行时基线 → GraphQL/HTTP 迁移 spike → 数据/服务层重整 → 按业务域切片迁移 → 灰度与清理**。Agentic harness 作为独立、默认不对公网开放的模块建设，第一阶段不接真实模型、不开放任意工具执行。

### 当前分支进度

已落地第一批止血与工程基线改动：修正匿名用户通过 `authChecker`、刷新/登录/忘记密码日志泄漏、使用 scrypt 建立新密码哈希并在旧 HMAC-SHA1 登录成功后渐进升级、密码重置改为短时签名 token 并在一次成功后失效、文章写操作所有权检查、会话读写/消息发送成员检查及已读字段修正；搜索用户/用户资料/关注列表改用白名单 DTO，不再返回邮箱和关系 ID；启动时 Mongo 连接失败会失败退出，加入 `/healthz`/`/readyz` 与 SIGINT/SIGTERM 停机，生产禁用内联 trace/landing page/schema 文件写入，修复 Docker 生产启动路径与 Compose 配置，并加入 CI、README、env 示例和 6 个单元/schema 测试。详见当前工作分支差异。

尚未完成项包括 refresh token 仅 HttpOnly cookie 流转/服务端重放检测、所有嵌套 GraphQL 类型的用户字段白名单审计（目前仅搜索/资料/关注查询完成脱敏）、GraphQL SSE 订阅级授权、限流/幂等、媒体 SSRF worker、关系写入事务一致性、分页/DataLoader、完整 Mongo 集成测试与数据库对账。Docker daemon 在当前执行环境不可用，因此 Compose/Docker 构建已配置 CI 校验但未在本地执行。

当前分支另已新增隔离的 `src/agentic/` Harness 原型：模型/工具接口、工具注册与 JSON Schema 边界、权限与精确输入摘要审批契约、预算/超时/取消 runtime、内存 run store、脱敏 trace、mock provider 与 golden evaluation。后续增量加入了 Mongoose `MongoRunStore` 与严格 schema、单文档 CAS 转移/事件追加及离线适配器测试；本轮增加了可选真实 Mongo integration test，并将 Compose Mongo 端口限制发布到主机 loopback，便于本地调试。当前执行环境没有 Docker CLI，所以 integration test 仅在未配置 `AGENTIC_MONGO_URI` 时验证默认 skip；live Mongo 并发、索引部署/迁移仍未验证，审批续跑/checkpoint、GraphQL/API 或真实模型也未实现。测试与生产缺口详见 [`docs/AGENTIC_HARNESS.md`](./AGENTIC_HARNESS.md)。

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
- **Harness 基座**：[#49 Agentic harness 开发基座](https://github.com/BrainEno/bot-thk-gqlserver/issues/49)。
- **Issue 治理**：[#50 审计 issue 去重与证据/优先级校准](https://github.com/BrainEno/bot-thk-gqlserver/issues/50)。

本次没有为 #1–#47 已记录的问题重复开票。issue 的“实测”描述应在执行修复时附可重现证据；若不能复现，应在治理时改为“静态判断”，不可把历史描述当成此轮已经运行验证。

## 4. 依赖现代化策略

截至 2026-11-25 的 npm registry 查询结果中，Apollo Server latest 为 5.5.2、Express 5.3.0、GraphQL 17.1.0、Mongoose 9.13.1、Typegoose 13.5.0、TypeScript 7.0.2、Puppeteer 25.18.1；TypeGraphQL latest tag 是 `2.0.0-rc.3`。这不是已验证兼容矩阵：尤其不能因为某个包存在更高 latest 版本，就直接部署 RC 或跨多个主版本同时升级。

| 当前项/风险 | 候选方向 | 决策门槛 |
| --- | --- | --- |
| `apollo-server-express` 3（EOL），并从未声明的 `apollo-server-core` 引入插件 | Apollo Server 5 + 受维护的 Express adapter；对照评估 GraphQL Yoga | 校验 Node 要求、Express adapter、GraphQL 版本、插件、错误格式、SSE 和客户端兼容性；先建最小 spike |
| TypeGraphQL 1.1 + GraphQL 15 | TypeGraphQL 2 仅在稳定发布后评估；否则评估 Pothos 或 SDL + Yoga | RC 不进生产；比较 decorator 迁移成本、resolver 中间件/验证/授权能力、GraphQL 16/17 peer 范围与长期维护 |
| Express 4 / TypeScript 4 / Node 18 镜像 | 选一个受支持 Node LTS（倾向 Node 24 LTS）和兼容 TS 稳定版；评估 Express 5 | 至少跑当前生产支持环境与目标 LTS 矩阵；更新 CJS/ESM 和启动配置，不能以放宽 engines 代替验证 |
| Mongoose 8 + Typegoose 12 | 成对升级到彼此明确支持的版本 | 单独检查 schema hooks、populate、transaction、index 与 TypeScript 类型变化；升级过程中保持 Mongo 数据格式兼容 |
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

## 6. Agentic Harness 开发基座

Harness 的目标是可控地运行、观测、回放和评测 agent，不是一个能任意调用 shell 或直接写业务数据库的 chatbot。建议初期作为独立模块/内部包（例如 `packages/agentic-harness`），不与 GraphQL resolver 混在一起，不默认开放公网入口；先提供 fake provider 和无副作用工具。

### 逻辑边界

**原型进度（本轮）**：在 fake skeleton 后，增加了 Mongoose `MongoRunStore` 与严格 schema、唯一 run ID / tenant-principal 索引、乐观版本 + 状态 CAS、单文档事件追加、terminal/counter 状态约束，并用 mock collection 覆盖跨范围读取、并发版本冲突、脱敏和状态转移；另外更新根目录 `AGENTS.md` 固化实现边界、验证命令和安全约束。离线测试不等于真实 Mongo 集成：未验证 live Mongo 并发、索引部署、崩溃恢复，也未实现审批续跑/checkpoint、provider、API 或业务工具。实现与生产门禁见 [`docs/AGENTIC_HARNESS.md`](./AGENTIC_HARNESS.md)。

```text
AgentRuntime
  ├── ModelProvider (接口；provider adapter 单独审批)
  ├── ToolRegistry -> ToolPolicy/Approval -> ToolExecutor (默认拒绝)
  ├── RunStore / Checkpoint / EventLog
  ├── Budget + Deadline + Cancellation
  └── Trace + Evaluator + Replay
```

- **Runtime**：明确状态机（queued/running/waiting-for-approval/succeeded/failed/cancelled）、最大轮数、token/成本/时长预算、重试/并发上限；HTTP handler 不直接持有长时间 agent loop。
- **Provider adapter**：厂商无关的输入/输出/usage/error 接口；不在初始阶段选供应商或把 SDK 类型泄漏进领域层；密钥使用 secret store，不进入配置样例和日志。
- **Tool registry**：每个工具声明名称、版本、JSON Schema、所需权限、超时、速率/资源上限、是否有副作用和人工审批要求。未知工具/无权限/无效参数全部拒绝；默认没有 shell、任意网络、文件系统或直接数据库写权限。
- **Policy/approval**：执行前依据用户/租户/资源授权；外部写入、发送消息、发布内容等动作先展示参数并等待明确批准；批准 token 短期、单次、与参数摘要绑定。
- **持久化与恢复**：run/step/tool output/event 都有 schema version；checkpoint 可恢复，命令幂等；跨服务副作用用 outbox 或明确的补偿操作；禁止盲目重放真实副作用。
- **Tracing 与隐私**：runId/stepId/toolCallId 全链路关联；记录成本/延迟/决策理由摘要和审计结果；prompt、用户资料、token、凭证按字段脱敏/最小保留；日志不存完整秘密或不必要的原文。
- **Eval**：确定性 fake model/tool 的单元和契约测试；策略拒绝/预算/超时/取消/重试/恢复测试；版本化 golden tasks、期望行为与安全回归；离线评测有质量、成本、延迟门槛。真实模型调用不在默认 PR CI 运行。

### Harness 建设步骤

1. ADR：威胁模型、信任边界、租户隔离、运行数据保留、审批定义、provider 与队列选择标准。
2. 无外部网络的 skeleton：接口、状态机、fake provider、2–3 个只读/纯函数工具；不接真实数据库写权限。
3. Tool registry、policy、预算、deadline/cancel、结构化事件和 checkpoint；测试“默认拒绝”。
4. 离线 eval/replay 与 CI 门禁；为 prompt/tool/schema 变更做版本化和回归。
5. 经安全审查后再加一个 provider adapter；再经产品/隐私/运维审批后，逐个加入有限权限的真实工具。
6. 只有当内部评测、授权与审计成熟后，另开产品化 issue 讨论 GraphQL/API 入口、用户界面、配额和 SLO。

**完成定义**：fake task 可重复得出稳定结果；未注册工具、超预算、未授权和超时都 fail closed；可取消/恢复；日志/trace 无秘密；不会绕过现有 service 授权；CI 无外部模型依赖。

## 7. 下一步建议

1. 先对 #1–#47 做 P0/P1 排序和 #50 去重，不要以框架迁移掩盖现有漏洞。
2. 将 #23 作为第一批实现：CI/基础测试和可工作的容器启动路径；然后补核心权限回归。
3. 由 #48 承接兼容 spike、迁移 ADR、API/数据契约和分阶段 PR；依赖升级拆成可回滚小步。
4. 同期只推进 #49 的 ADR 与 fake skeleton；等基础 CI 和服务层权限边界稳定后再接 provider/真实工具。
