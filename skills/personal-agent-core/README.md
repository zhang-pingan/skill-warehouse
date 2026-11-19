# Personal Agent Core · 私人助理

Local Cordis plugin for historical task recall, source-backed memory, persistent assistant tasks and DSH/Codex workers. The assistant uses the standard preset and the user's model/access settings. History recall never creates or completes executable tasks.

侧边栏的私人助理入口打开独立页面，页面与微信共用唯一主会话，复用 Harness 原生对话和输入组件。普通会话不能通过命令切换为私人助理；调用记忆工具只记录来源，不改变会话身份。切换到普通会话后再次打开入口，会恢复主会话及其未发送草稿。页面头部提供记忆提炼状态、任务看板和记忆系统入口。

主会话可直接回答一般问题、查询执行进度和处理合适的工作。会话中记录的私人助理工作说明引导它在需要历史依据时调用记忆工具，并把实质性或长期任务路由给 worker；插件不会用记忆数据限制主会话权限。

## 文档

本 README 是插件总入口。当前功能与运维文档位于 `docs/`；评测说明、方案、执行代码、语料与结果统一位于 `test/evaluation/`。

| 文档 | 内容 |
| --- | --- |
| [架构与数据](docs/architecture.md) | 组件、初始化和本地记录 |
| [任务与执行](docs/tasks-and-workers.md) | 完整消息执行流程、目标匹配、原会话续接、新建 worker 与结果验收 |
| [历史与记忆](docs/history-and-knowledge.md) | 历史同步、记忆提炼与检索 |
| [设置与运维](docs/settings-and-operations.md) | 默认 worker、模型策略、后台任务与主会话维护 |
| [微信与主会话互通](docs/wechat.md) | 登录、扫码身份核验、文字同步、审批与投递恢复 |
| [安全与恢复](docs/security-and-recovery.md) | 来源权限、Codex 审批、未知执行与恢复 hold |
| [验证](docs/verification.md) | 插件检查、性能基准与 Harness 集成探针 |
| [评测体系](test/evaluation/README.md) | 评测文档、运行方法、语料、评分与结果入口 |

## History and memory

Importers read all eligible DSH and enabled Codex history into a staged message manifest. Injected context, private reasoning and this plugin's analysis sessions are excluded. A recorded native AI analysis identifies historical tasks, including noncontiguous continuation and shared messages. The Host verifies complete ownership before atomically publishing tasks, original evidence and indexes. Missing, repeated or unknown message IDs produce specific feedback and retry the current chunk within `memoryExtractionRetryLimit`; rejected drafts leave the task directory and assignments unchanged. Unresolved messages stay visible in coverage and are reconsidered when new conversation context arrives; unchanged sessions are not repeatedly analyzed. Final reconciliation can merge new duplicate drafts into another new draft or an existing task; it never removes a published task ID. Invalid merge identities receive the allowed source and target IDs for repair. Invalid results do not advance the published revision. A Codex import write failure retains the chunk cursor for an idempotent retry instead of skipping failed inputs.

Each changed task version binds its title, goal, summary, state and source hashes, and is extracted with its summary and original message excerpts. Source-read and chunk-preparation failures consume a bounded task attempt and remain visible in queue errors. Empty valid output completes that version. Exact quotes, identifiers and entity references are checked before candidates and task links are published. Invalid fields, malformed JSON, empty text and oversized model responses retry the current chunk with diagnostic feedback within `memoryExtractionRetryLimit`; validated chunks are reused within the same run, and the complete version publishes atomically. Reusable entities and memories retain their existing identity; new model output is forced to candidate even if the response supplies a trusted state. Deleting a task or source invalidates in-flight snapshots, resets retries for the revised session and refreshes surviving task versions. Sources retain their original text and location. Background requests append the configured output-language instruction; the main conversation does not consume this setting.

`search_history` returns historical task pages with grouped raw matches, source activity, filters and coverage. `memory_search` has a separate `sessionTasks` group; `tasks` still means the execution ledger. Its `historyPage` reports totals, `hasMore` and `nextOffset` for task and supplementary-source lanes; pass `nextOffset` as `offset` to continue those lanes. Knowledge lanes retain their own bounded first-page results. `memory_get` reads a task, paged messages, individual sources or surrounding conversation. Missing `memory_get` and `get_task` records return `null`; `list_steps` returns an array, including an empty array. These are valid tool results. Source reads work identically for hot and gzip-archived bodies. Relevance does not depend on storage temperature.

The memory browser searches task summaries, memories and entities by default. **Search original conversations and execution records** is local to that page and defaults off. Raw hits group under tasks; unprocessed, unresolved and no-task hits are supplementary and use the same applicable source, session, project, entity and date filters. Both result lanes retain earlier pages on Load more; graph connections include endpoints from earlier pages. The graph shows loaded tasks, memories, entities and assistant tasks, with all available connections drawn before selection. Types form labeled regions with colored clouds. Nodes have luminous cores, depth-dependent glows, gentle drift and breathing; hover and selection use animated pink/violet rings, textured light and crosshair guides. Curved relationships carry soft filaments and moving light pulses. Selection emphasizes the object and its links without dimming unrelated nodes or the background. Nearby pointer movement enlarges the local region, hover highlights an object or relationship, and click opens details. Stored relationships expose their endpoints and sources; task-derived connections provide read-only explanations and endpoint links. Empty-space clicks, a second click on the selected object, Clear selection and Escape immediately clear both node and relationship selection and cancel pending detail reads while rings and connection highlights fade out. Escape closes the page only when nothing is selected. The scene rotates slowly when idle, pauses automatic rotation and drift during pointer inspection or selection, and uses smooth zoom/pan transitions. Drag inertia continues after release even with a selected node or relationship, then gradually settles. Source messages are not graph nodes. Related context nodes are outlined. Keyboard users open the same objects through the result list; narrow layouts use drawers.

The assistant's extraction page owns Extract now and Retry failed extraction. Pending task extraction precedes new session analysis. Each chunk validates literal alias support, unique canonical names, entity references and record fields before publication, so rejected output can be repaired without reaching database writes. Failed/cancelled/interrupted runs use stable cursor pagination and a collapsed list. Successful and empty-success runs remain in the ledger and native logs. Current queue errors are independent of historical failure count. An unrelated failed task does not stop successful batches; a failure in the current batch stops that run. The processed count totals all completed batches. Failures from obsolete session or task versions remain in execution logs without changing the current version’s error or retry count.

The decorative background combines blue/violet cloud textures, five star-dust orbits, a luminous spiral core and video. Its visibility does not depend on record count or selection, and decorative particles are never selectable. Reduced motion keeps the nebula static; hidden pages pause canvas animation, and closing the graph releases frames, listeners and textures.

Memory controls and task panels use Harness button and icon primitives with the active skin’s colors, borders and radii. Task groups have rotating disclosure chevrons and count badges; task and memory rows share compact spacing, wrapping titles and visible hover/focus states.

On macOS, the extraction panel, task panel and memory page fill the window height. Their headers reserve horizontal space for native window controls when needed, including in narrow windows.

## Storage and settings

SQLite defaults to `~/.dsh/personal-agent-core/ledger.sqlite`; schema version is 3. Versions 1 and 2 gain additive main-session, WeChat, task-source and execution-result tables without clearing existing records. Source blobs hold hot text or verified gzip bytes in the same database. Backups include both. The default query window is 30 days, hot-body threshold is 90 days, candidate-review reminder is 90 days, and capacity limit is 10 GiB. These values are settings. No automatic age-based permanent deletion occurs. Candidates never become confirmed merely by aging.

Settings use collapsible, theme-aware groups for the main conversation, history, recovery, backups, extraction, retention, background analysis, WeChat and workers. Valid changes apply automatically: switches and selectors submit immediately, while text and numbers submit after a brief pause or on blur. In-flight writes survive settings navigation; invalid or failed edits remain visible with validation or retry feedback. Linked model policies, presets and the default worker priority are submitted together. Restore defaults requires confirmation and preserves the Codex switch. The background language selector offers Simplified Chinese (`zh-CN`, the default) and English (`en`). Codex history and workers share one switch in Worker settings. The saved switch owns App Server connection, new-thread, resume and explicit-fork permissions; startup repairs those derived flags from the saved setting. Model tools cannot change the switch. Connection starts in the background after app readiness, and settings distinguish connecting, connected and failure states with a reconnect action. Import failure preserves the previous setting; connection failure leaves enablement saved and visible for retry. Disabling waits for scans and connection attempts, disconnects the plugin adapter, and rejects while Codex work is active or unresolved. Disabling Codex removes staged task history as well as removable local mirrors; protected operational/knowledge sources remain. Originals are unchanged.

Codex connections enable the experimental API capability by default so App Server accepts the worker's runtime workspace roots. This capability declaration does not grant execution or filesystem permissions. The explicit opt-out and connection requirements are documented in [settings and operations](docs/settings-and-operations.md#设置页).

## Tasks and workers

Execution discovers ledger Tasks and historical DSH/Codex work before selecting a worker. Existing work retains its native Session/Thread, effective preset and model. DSH continuation reads the native current directory, including persisted directory changes: omitting `workspacePath` retains it, while supplying a valid directory switches the same Session before delivery. Codex continuation uses the effective cwd from `thread/resume`; explicit directories are applied through the next turn, and forks preserve all native runtime workspace roots. Both backends validate the adopted path as an existing directory; an explicit replacement does not require the previous directory to exist. Each execution records its adopted directory; write leases and baselines use that directory while the Task retains its project association. Missing, busy, archived, ambiguous or incompletely searched sources block automatic replacement. Explicit `worker: "internal"` records work performed in the main conversation while preserving the Task's external worker association.

New delegated workers use two branches: the main model supplies `worker: "dsh_subagent"` with `agentPreset: "cordis"` for creating or maintaining DSH plugins; otherwise it omits both and the Host reads `defaultWorkerPriority` (`dsh_standard`, `dsh_cordis`, or enabled `codex`). Host routing does not use keyword or PTC selection rules. Configuration, model policies and feature flags are described in [settings and operations](docs/settings-and-operations.md).

A new Task with a new worker derives its project from the validated requested directory; historical work remains a source association. An explicit conflicting project is rejected before the Task is created. Continuing or forking an existing worker retains the original Task project.

DSH executor associations are published after native startup accepts the request. Native name rejection permits a corrected request on the same Task without a nonexistent worker association. Unknown startup outcomes retain reconciliation and any workspace hold; a confirmed native terminal can restore missing associations, while conflicting identities stop settlement.

Task, Execution and native Session are separate identities. Request deduplication, task admission and workspace leases protect dispatch. Results remain durable and require evidence-backed acceptance; a successful worker turn does not complete a Task. Terminal Codex notices include the execution-bound evidence ID and register pending criteria. `get_task.verification` exposes criterion IDs and current execution result evidence, including previously recorded results; replay preserves existing acceptance verdicts. Unknown dispatch or delivery outcomes require reconciliation before retry or replacement. The [execution guide](docs/tasks-and-workers.md) owns target selection, continuation, cancellation and result delivery; [security and recovery](docs/security-and-recovery.md) owns authority and recovery holds. Configuration compatibility is documented in [settings and operations](docs/settings-and-operations.md#设置页).

## Initialization and data compatibility

The Host creates the current schema for an empty database and extends supported versions 1 and 2 to version 3 while preserving records. Unsupported existing databases fail to load without automatic deletion. See [data compatibility and loading failures](docs/settings-and-operations.md#数据兼容与加载故障); changing the version number alone does not initialize a database.

Initialize memory drains writers, clears plugin records and managed backups, preserves WeChat records and credentials, restores saved settings, flags and the private assistant's original Session binding, then imports history into staging. Task analysis and knowledge extraction proceed afterward. Original DSH/Codex Sessions, workspace files and unmanaged backups are outside the reset. Active or unreconciled executions must settle before reset.

## WeChat and the main conversation

The optional Tencent iLink channel connects one verified personal WeChat account to the same Host-owned main Session as the assistant page. It defaults off; matching the message sender against the authenticated QR scanner binds the owner automatically. The main Session is acquired without a session picker. Ordinary memory writes do not grant assistant identity. Final-reply sync defaults on; desktop-user mirroring and one-time remote approval default off.

The channel supports private text messages. Incoming requests are deduplicated, completed replies are delivered as durable ordered segments, and idle observation does not restore the main Agent. Unknown delivery outcomes require local review. Questions and approvals retain their original scope and expire with their Session or connection. Credentials remain in Harness storage, and account locks protect receiving and account management. The [WeChat guide](docs/wechat.md) owns sign-in, identity states, commands, queue recovery, configuration and transport limitations; [third-party notices](THIRD_PARTY_NOTICES.md) identify included libraries.

The main conversation name defaults to “鲸鱼娘”. Clear main conversation history archives and numbers the old Session, synchronizes eligible history, and creates an empty replacement while preserving memories, tasks and WeChat authorization. The canonical Session binding and channel observation position change together. See [main conversation maintenance](docs/settings-and-operations.md#主会话维护) for confirmation, preserved data and failure recovery.

## Validation

History retrieval scans indexed bodies once per request and aggregates task activity in batches. It preserves complete counts and paging while retaining only bounded snippets and the supplementary result page; it does not cache results between requests or change lexical matching. Local query measurements and query-thread resource limits are documented in the [evaluation guide](test/evaluation/README.md#b0-性能基线).

Run `npm run check` for syntax and the plugin's behavioral tests. `node test/history.perf.js` measures synthetic index-import cost. The [history evaluation suite](test/evaluation/README.md) owns the synthetic corpus, retrieval scores, frozen baseline and isolated real-model probe; retrieval scores do not establish end-to-end answer or worker quality. The keyless real-Harness probe and rendered UI workflow are documented in [verification](docs/verification.md). The plugin is installed as a local linked bundle; Host code requires a Harness restart.

## 文档维护

文档以当前源码、有效配置和验证结果为准，维护功能、数据语义、配置、运维和限制。消息执行流程集中在“任务与执行”，配置集中在“设置与运维”，权限与未知状态处理集中在“安全与恢复”，验证方式集中在“验证”；本 README 保留能力摘要并链接对应文档。文档属于本插件，随插件源码一起维护。

只维护基于当前代码的整体文档。实施和复核完成后，将方案中仍有效的内容归入对应主题，删除独立方案及其引用；不保留或另行归档开发计划、阶段进度、迭代记录、实施报告和按版本累积的开发说明。当前仍支持的配置兼容、数据初始化和恢复方法直接写入现有运维文档。第三方许可声明单独保留。

仍在执行的评测方案和验证记录集中在 `test/evaluation/docs/`，任务完成或终止后按评测说明收尾。可复现的语料、执行代码、有效基线和冻结结果归评测体系维护；已有结果的输入、失败记录、源码快照和哈希不因文档迁移而改写。

Worker 设置中的工作目录白名单同时约束 DSH 和 Codex，默认留空；新建 worker 未指定目录时使用各自的默认工作区，已有会话沿用原生当前目录。配置方法见[设置与运维](docs/settings-and-operations.md)，目录规则见[任务与执行](docs/tasks-and-workers.md#工作目录)。
