# 架构与数据

`personal-agent-core/index.js` 注册工具、页面路由和后台任务；`PersonalAgentService` 组合 SQLite、导入、记忆、worker、审批和恢复服务。`client.js` 提供独立私人助理页面、原生 Conversation、任务看板、提炼记录和 Canvas 记忆图。主会话绑定及草稿在页面切换后保留。自定义 profile 需要提供插件入口 `inject` 声明的 Host 服务，其中 `sessionQuery` 与 `sessionProjections` 用于持久会话查询和状态恢复。

## 数据分层

| 层 | 保存内容 |
| --- | --- |
| `history_sessions`、`history_messages` | 来源快照、稳定消息身份、暂存原文、归属覆盖及发布版本 |
| `session_tasks`、`session_task_messages` | 会话内工作目标、概述、历史状态、实际活动时间和多对多消息归属 |
| `source_records`、`source_blobs`、`evidence` | 已验证归属后的原始来源、热正文或 gzip 正文及引用 |
| `session_task_memories` | 历史任务与已提炼或复用记忆的关联 |
| `memory_entities`、`memory_records`、`memory_edges` | 共享实体、候选及已确认知识、业务关系和精确来源 |
| `analysis_runs` | 后台运行状态、模型、数量、错误和原生子会话地址 |
| Task、Execution 及关联表 | 助理执行、审批、验收、租约和恢复状态 |
| `task_sources` | 历史工作与执行 Task 的稳定关联、来源版本及消息引用 |
| `dsh_execution_runs`、`execution_results` | 原生 DSH 请求和结果范围、终止回执、结果通知及交付状态 |
| `main_session_binding` | Host 固定主会话及绑定版本 |
| `wechat_channel`、`wechat_contacts`、`wechat_inbox`、`wechat_outbox`、`wechat_interactions` | 非秘密账号绑定、收件身份、投递分段、互动有效期与恢复 hold |
| FTS5 表 | 可重建的来源与记忆文字索引 |

脚本先准备完整消息清单；原生 AI 子会话按上下文划分任务，Host 验证覆盖、引用和版本后原子发布。长会话分批处理并保留任务目录，最后整合重复任务；同一消息可以关联多个目标。增量继续已有稳定任务 ID，任务版本绑定标题、目标、概述、历史状态和来源哈希；删除操作同步更新版本，拒绝在途旧快照回写。任务提炼使用原文，摘要不是证据。已处理空结果与失败分别记录。

实体关联从任务的来源证据及记忆得到，不为每个任务复制实体。任务和知识独立于执行账本：历史里“已完成”的描述不会完成任何助理任务。

## 生命周期与持久化

SQLite `user_version=3`；从版本 1、2 追加主会话、微信、任务来源关联及执行结果表，保留已有数据。不支持的更早结构在打开时失败，不自动清空。支持范围和加载故障处理见[数据兼容与加载故障](settings-and-operations.md#数据兼容与加载故障)。初始化清空插件记录和托管备份，保留运行设置、功能开关、固定主会话绑定和微信记录及授权；上游原始 Session 不受影响。

Host 就绪后启动历史同步，再按配置触发任务划分和提炼；周期调度继续处理积压。一次运行受批次数量和请求预算限制，同一时刻只运行一条提炼流水线。关闭时取消来源读取和分析，等待已登记操作及子会话清理，再关闭 adapter 和数据库。

较早任务的全部已处理正文可以 gzip 压缩在同一 SQLite blob 行中。写入、回读校验和释放热正文原子完成；共享的近期来源、未归属或尚未完成提炼的来源保持热存储。统一 `source_text` 读取函数进行有界解压与哈希校验，索引重建、提炼、详情和来源校验共用它。备份包含热与冷正文，校验同时检查压缩体。缺失或损坏返回错误，不伪装成无结果。

数据默认位于 `~/.dsh/personal-agent-core/ledger.sqlite`，托管备份在同目录 `backups/`。DSH Session Persistence 和 `$CODEX_HOME`/`~/.codex` 的原始会话是独立来源。

参见[历史与记忆](history-and-knowledge.md)、[任务与执行](tasks-and-workers.md)、[安全与恢复](security-and-recovery.md)。

微信由独立通道管理账号锁、长轮询与持久队列；主会话通过 Host 服务唯一创建和恢复，前端读取同一绑定。原生输入与最终输出使用 Harness 接口和增量 projection，详见[微信互通](wechat.md)。

私人助理身份只由 `main_session_binding` 的唯一会话 ID 决定。记忆写入关联当前用户消息及原会话，`session_refs.source_kind` 不授予助理身份；初始化服务时将旧 `personal_assistant` 来源类型改为 `interaction`，保留原会话、记忆及证据关联。

主会话清理通过原生归档限制旧会话的新输入，完成历史同步后创建替代 Session。`background_job_status` 的 `main-session-reset` 项保存阶段、旧新身份、命名快照和归档编号，重试复用已预留的新身份及编号。唯一绑定与微信 generation、会话版本、事件观察位置在同一 SQLite 事务切换；提交前错误尝试恢复旧标题和归档状态，提交后错误只影响通道收尾。卸载等待清理结束后才关闭数据库。初始化记忆保留该手动维护状态。标题由原生 `sessionTitle` 服务写入，获取主会话时对相同标题去重。

执行目标解析由 `execution-discovery.js` 与 `execution-flow.js` 统一提供；新建选择由 `worker-policy.js` 读取配置，不分析目标关键词。`personalAgentExecution` 原生 Session projection 保存当前执行、最终结果及通知回执，查询使用 Host projection/checkpoint。`execution-results.js` 仅恢复未完成执行及通知；新输入、输出和工作说明都通过原生 Session 事件记录，主会话说明按版本去重。微信与执行投影的缓存由原生日志重建，缓存版本变化不要求清空主会话或记忆库。来源正文仍按不可信数据处理。
