---
description: 合成历史评测集、生产检索基线、模型探针及可复现的评分规则。
---

# 历史与记忆评测

此目录用合成资料测量私人助理现有的历史检索、记忆召回和执行目标候选发现。数据和评分工具不属于插件 bundle，不读取日常账本，不向日常主会话或微信派发任务。原生测量使用独立存储中的真实主会话和 worker。当前结果与未验证部分见[基线报告](../../../dsh-personal-assistant/docs/plans/baseline-report.md)。

## 数据与分组

[`corpus.json`](corpus.json) 保存来源消息、预先整理的会话任务和记忆快照；[`cases.json`](cases.json) 独立保存请求、固定检索词、预期 ID、答案要点与禁止结果。评分标签不进入数据库、检索请求或模型输入。两文件在运行清单中以 SHA-256 固定。

评测集包含 60 个不同主题的合成来源族、300 题、110 个会话、120 个会话任务、428 条消息和 180 条记忆。10 个来源族包含同一会话的两个任务。探索集为 36 族/180 题，验证集为 12 族/60 题，封存集为 12 族/60 题。来源族不跨组；同一来源的五题共享资料，题型模板也跨族复用，因此不能把 300 题视为 300 个独立真实历史。

当前只执行探索集和验证集。封存集仅进行 ID、时间、归属和精确引文的结构检查，没有运行检索、模型调用或输出逐例结果。来源日期按固定 SHA-256 排列分配，与分组编号解耦；具体规则写在语料元数据中。后续若查看其细项或用于调参，应将其转为回归集并补充新的确认样本。

观测时点固定为 `2026-11-18T00:00:00.000Z`，来源均早于该时点。个别请求的 `asOf` 是从当前资料询问过去约定的时间，不代表把数据库恢复到过去；当前任务摘要和后续纠正仍可见。评测不包含未来于观测时点的消息。

## 运行检索基线

在插件目录运行：

```sh
npm run test:evaluation
node test/evaluation/run.js /Users/chelaile/Documents/deepseek-harness/default-workspace/personal-agent-core /Users/chelaile/Documents/deepseek-harness/default-workspace/personal-agent-core/test/evaluation/results/b0-final-retrieval-2026-11-18
```

第二条是当前基线的实际命令。复跑必须换一个不存在的结果目录；运行器拒绝覆盖已有清单。也可用 `npm run eval:baseline` 自动生成新的结果目录，或在命令中指定隔离候选源码路径。执行时保持该源码及其依赖不变；清单记录文件哈希、Node/SQLite/CPU 版本与评分规则。

[`fixture.js`](fixture.js) 使用独立临时目录、SQLite 和 Codex home。来源通过生产导入写入方法存储，已发布任务归属按合成快照灌入；不运行分段或记忆提炼模型。[`run.js`](run.js) 调用生产 `search_history`、`memory_search` 和 `discoverExecutionTargets`。每种原文存储状态运行三次独立建库，每次做首次遍历和重复遍历，分别请求 10/50 条候选。结果目录保存执行前清单、逐例 JSONL 和汇总；临时库在结束时关闭和删除。

“热正文”指普通正文，“归档正文”指 gzip 压缩正文，两者保留同一全文索引。首次遍历紧接建库，不清空操作系统文件缓存，也不等同于冷启动。“重复遍历”只是同一连接上的第二遍。耗时不包含模型、网络或 UI；建库时间包括来源写入和索引创建，不能冒充增量更新成本。

## 评分口径

| 指标 | 分母及含义 |
| --- | --- |
| 任务 Recall@K | 有预期任务的用例中，前 K 个返回任务覆盖的预期任务比例 |
| 证据覆盖@K | 前 K 个任务/记忆返回的 `matches`、`messages`、`sources` 以及补充原文中，覆盖必要消息 ID 的比例；不是全局排序的前 K 条证据 |
| 记忆 Recall@K | `memory_search` 前 K 条记忆覆盖预期记忆的比例；历史查询和目标发现不计此项 |
| 任务 MRR | 第一个正确任务的倒数排名，未命中为 0 |
| p50/p95 | 指定接口、K、存储状态、遍历轮次和数据分组的实际调用延迟 |
| 覆盖不完整 | 原样记录生产返回的候选截断、待归属、原文补充和错误信息 |

空 gold 的用例不计入召回分母；它们仍进入调用耗时、错误及覆盖统计。返回历史材料不等于模型根据材料作出了正确拒答，因此不从“没有结果”推算拒答正确率。错误或未执行查询对有 gold 项计 0，不删除失败用例。

[`score.js`](score.js) 先在来源族内求均值，再对来源族做固定种子的 2,000 次 bootstrap，报告 95% 描述性区间。重复运行不增加独立样本数。合成题型相关、来源族少、人工预置任务归属及轻量数据规模限制了外推；这些区间不能直接代表真实个人数据库的总体准确率或正式上线收益。

## 真实模型探针

[`run-harness.js`](run-harness.js) 从指定 checkout 通过支持的 DSH Web profile 启动独立 Harness，装载 [`harness-probe.js`](harness-probe.js)。DSH、Codex、Agent 和用户 home 均放在本次临时目录内；只复制选定 provider 的凭据引用到私有文件，退出后删除该凭据。端口动态分配，endpoint 要求本机连接和本次随机 token。不要把含凭据的 provider 文件或临时私有运行配置加入结果目录。

`startHarness` 需要 `checkout`、`provider`、`model`、`providerPatchPath` 以及凭据文件或对应环境变量；可选 `root` 和 `reasoningEffort`。`infer` 运行真实 `managedAnalysis`，记录原生分析会话、每次模型尝试及可用 token。这个入口不注册 fixture 模型。

[`run-model.js`](run-model.js) 提供生产 `semanticCandidates` 的小样本测量入口，取每类首个探索来源族的 route 用例，预先登记后重复三次。配置中的 `candidateLimit` 只接受检索协议已有的 10 或 50，省略时为 50；可用 `analysisInputChars` 显式重现已确认的有效输入预算，不修改插件默认值或日常设置。输入、模型结果、原生尝试用量和失败均保存到独立结果目录。没有预期目标的用例不进入目标正确率分母，但仍计入失败、延迟和用量。它不执行原生会话检查或 worker，不代表完整主会话效果。

模型测量使用已配置的 `openai/gpt-6.2-sol`，省略推理等级并沿用 provider 默认值。K=50 采用用户设置的 100,000 字符输入预算，插件源码默认仍为 48,000；预算和候选窗口必须分别记录，配置差异不能当作检索算法收益。调用失败与成功请求均进入基线，结果见[基线报告](../../../dsh-personal-assistant/docs/plans/baseline-report.md#真实模型状态)。

复跑模型测量可使用结果目录内的 `run-config.json`，其中只有本机路径和模型/候选数量，没有凭据值。传入一个新的输出目录，例如：

```sh
node test/evaluation/run-model.js test/evaluation/results/b0-model-k10-2026-11-18/run-config.json /absolute/path/to/new-results
```

路径须按本机配置调整；实际执行过的命令与结果保存在基线报告。更新后的凭据由运行器在启动时读取，不写入评测结果；原生 Session 日志只包含合成输入与模型响应。

## 原生主会话与 worker 测量

[`run-native.js`](run-native.js) 使用同一模型，通过 [`native-probe.js`](native-probe.js) 运行生产 `MainSession`、私人助理工作说明及 `personal_agent` 工具。每次重新建立合成账本；模型自行选择检索词、读取原文并回答。固定选择每类首个探索族的问答题，再加 001、006 两道无证据题，重复三次。查询传入原题、`request.asOf`、固定资料观测时点和 UTC 约定；金标准和预期用语不进入模型请求。

worker 测量使用独立的分组求和资料，分别经生产 `executeObjective` 新建 DSH 标准模式和 Codex 会话，再通过 `taskId` 续接原会话，重复三次。核对实际输出 JSON、源文件约束和会话身份；这是原生执行与续接的小型保护样例，不代表广泛编码能力、自动目标发现或主会话完整委派闭环。Codex 使用同一个已配置 API 地址和模型、单独的配置与凭据，退出后停止其专用 daemon 并删除凭据。

`run-native.js CONFIG NEW_OUTPUT_DIR main|workers|codex` 分别执行主会话、两种 worker 或仅 Codex。未提供 `experimentalCodexApi` 时使用被测插件的默认能力声明；显式布尔值用于对照，清单记录生效值。当前插件默认开启该能力，Codex 0.150.1 需要它才能接受 `runtimeWorkspaceRoots`。冻结 B0 中默认关闭造成的失败及显式开启的补测结果保留原样；复跑冻结条件应使用保存的源码和配置。评测使用已安装 standalone runtime 的独立副本，保留版本；`codexInstallPath` 可指定该 runtime 目录，不读取日常 Codex 配置或会话。

原生主会话每题最多 120 秒，worker 每组新建加续接最多 240 秒。失败、超时、澄清等待和原始响应全部保留。单次模型调用与 token 从原生尝试取数；`review-native.js` 检查引用 ID 和用量，只给出诊断，不将关键词匹配当作语义质量。语义审阅需要对照独立 gold 与原文，并与机器可确定的引用覆盖分开报告。

`judge-native.js` 使用固定来源与评分准则做独立请求的语义审阅，清单注明评判与回答同模型的相关风险；它不构成独立人工盲评。`score-workers.js` 确定性比较最终产物、会话身份及源文件约束。`account-workers.js` 按 DSH 会话/事件编号去重；Codex 从归档原生日志只取每个独立会话的最终累计值，并核对逐次用量和 adapter 最终值，避免将两轮累计数相加。

`archive-run.js OUTPUT_DIR` 在运行退出且临时凭据删除后归档冻结工具和原生 Session，工具哈希改变或档案已存在即拒绝。当前版本不应拿来重归档使用旧工具哈希的轮次；每轮保存自己的源码快照。后处理结果记录其工具及输入哈希，不改写原始结果、语料或 gold。

评测输入必须包含题目要求的时间和时区条件。夹具或工具接口故障与模型质量分开记录：修复实现故障后重新冻结受影响场景，保留旧证据；不得修改 gold、过滤失败或只挑选成功重复。

## 自主执行、生命周期与规模

[`run-autonomy.js`](run-autonomy.js) 通过 [`autonomy-probe.js`](autonomy-probe.js) 提交真实主会话请求，使用生产工具、结果交付事件和验收记录。模型自行检索、选择目标、决定是否委派并核实结果；没有给模型规定工具调用顺序。十个固定场景各重复三次，覆盖默认 DSH/Codex 新建、原会话续接、跨项目歧义、原生来源不可用、历史指令、过期摘要与直接回答。相同场景的后端变体共享来源族，三次重复不算新增独立样本。

[`autonomy-cases.json`](autonomy-cases.json) 在调用前固定输入与 gold；只有 `input` 发给隔离探针，预期输出留在评分端。`run-autonomy-batch.js CONFIG NEW_OUTPUT_DIR REPEAT` 每次为一道题启动独立 profile，防止按需历史导入读到之前的测量会话。每个场景使用独立工作目录，续接场景先建立真实 worker 再向主会话发送没有任务 ID 的继续请求。测量保留准备时间、测量起点、原生事件、工具结果、原会话身份、执行账本及验收状态。`score-autonomy.js` 检查精确 JSON、文件未被改动、后端/会话身份和已持久化验收；自然语言解释中的词语只作为定位线索，仍须对照来源审阅。

自主执行的完成终点包括原生轮次完成，或真实 `user-questions/request` 与未结束的持久化 `ask_user_question` 调用一致且没有新增执行。普通问句不能替代请求证据；捕获等待状态后的取消只用于清理。每题 240 秒预算覆盖准备与测量，`elapsedMs` 单列实际用户请求阶段，`setupMs` 记录夹具和续接种子。

完整工作区指标检查新增、删除、修改及符号链接；`sourceUnchanged` 仅检查 source.json，作为旧口径单独保留。`account-autonomy-tree.js` 核对原生 Codex 子代理树的归属和每个会话逐次/累计用量，将种子与测量阶段分开；中止尝试缺少用量时报告下界。

```sh
node test/evaluation/run-autonomy.js CONFIG NEW_OUTPUT_DIR
node test/evaluation/score-autonomy.js NEW_OUTPUT_DIR
node test/evaluation/archive-run.js NEW_OUTPUT_DIR
```

[`lifecycle-run.js`](lifecycle-run.js) 测量真实原生压缩和退出后恢复同一主会话，同时验证重复 worker 请求不重复执行。`run-harness.js` 的 `restoreRoot` 仅允许本评测器正常关闭、具有所有权记录且配置指纹相同的隔离目录；恢复时更新临时凭据和访问 token，不读取日常会话。生命周期结果不代表执行中强杀、自动压力压缩或所有后端故障恢复均已测量。

[`scale-run.js`](scale-run.js) 使用混合长度与热/归档正文的 1,000、10,000、50,000 条合成消息，分别测量索引体积、生产服务重新打开、首次/重复检索和独立进程资源。真实 DSH Web profile 的启动到插件健康可用单独记录；它不等于桌面首屏绘制。操作系统缓存未强制清空，首次查询和操作系统冷缓存必须分开描述。正式性能测量与其他自有 CPU 密集任务串行。

[`incremental-run.js`](incremental-run.js) 在 1k/10k/50k 消息库上测量生产来源追加、记忆新增和修改，每项三次独立样本、每样本二十次操作，并核对索引、来源及完整性；WAL checkpoint 单列，不混入模型提炼成本。

增量协议固定了被测源码指纹，复现时使用该轮保存的源码快照；新实验须预先登记自己的协议与输出目录。汇总的 `batchMs` 是二十次写入的整批耗时，不能当作单次写入延迟。

[`confirmation-design.md`](confirmation-design.md) 与 [`confirmation-design.json`](confirmation-design.json) 固定后续候选的来源族采样、三次成对重复、应用门槛、区间与跨候选错误率控制。样本量规划由 [`confirmation-design-analysis.js`](confirmation-design-analysis.js) 复现。B0 要求这些规则和对照证据可重现；未来候选的未见确认样本与 A/B 检验在候选固定后执行，不以当前小样本代替正式确认。

## 后续比较条件

改进检索前必须保留本基线的源码身份、语料、评分和资源条件；每次只比较一个候选因素。正式比较同时保留单步收益与相对 B0 的累计变化，并以来源族作成对统计。默认质量门槛为提高至少 5 个百分点、95% 成对区间下界大于 0；效率门槛为至少降低 20%，同时满足质量非劣条件；p95 与 token 增幅各不超过 10%，关键回归为 0。完整规则见[方案](../../../dsh-personal-assistant/docs/plans/memory-retrieval-context-plan.md)。

检索召回提升本身不能放行应用。正式确认样本量须在候选实验前依据主指标、最小收益和来源族方差登记；当前小规模合成集不构成 1 个百分点非劣检验或 5 个百分点收益的功效保证。DSH 目录、Codex 默认兼容、验收证据交付及工具返回等流程故障已修复并验证。B0 指标基线已完成：自主执行、生命周期与启动在当前冻结源码上重测，其余测量按调用路径核验复用，并保留实际源码身份。全部预定重复、失败和限制见[基线报告](../../../dsh-personal-assistant/docs/plans/baseline-report.md)及[完成记录](results/b0-complete-2026-11-18/release-decision.json)。第 2、3 项尚未开始。

原生 Codex worker 探针支持可选的 `input.operationsAudit: true`：在新建与续接测量后，建立带两个工作区根目录的隔离来源，验证生产执行入口的历史接管、明确分叉和重连续接。返回 `operationsAudit` 中的有效设置、执行目录、来源历史比较及 Thread 关系；这是操作回归验证，不计入已冻结的检索基线。

`input.directoryParity: true` 验证显式目录切换：在隔离 Thread 的旧目录被移除后，经生产续接入口指定新目录，核对原 Thread ID、原生有效目录，以及 Execution、租约和 baseline 的位置一致。
