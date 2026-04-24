# Refiner Agent 设计文档

> 本文只描述 Refiner 层的**模型、契约与推理规则**，不涉及前端界面、进度排期、版本划分。实现代码位于
> `packages/opencode/src/refiner/`，提示词位于 `packages/opencode/src/agent/prompt/refiner.txt`，
> 磁盘目录 `.opencode/refiner-memory/`。

---

## 1. 角色与边界

Refiner 是一个**离线/旁路**的 agent：它不参与 workflow 执行，也不直接回答用户。它的唯一职责是从会话
与 workflow 快照中**提炼可复用的经验**，把它们组织成一张有向图，供 Master / Slave 在未来会话里
按需召回。

三条硬边界：

1. **不复述**。Refiner 的输出是**抽象**，不是"用户说了什么"的记录。输出里看到大段用户原文 = 失败。
2. **不裁决**。Refiner 只标记冲突（`contradicts` / `conflicts_with`），是否真正矛盾、哪条为准，
   交给用户或上层 agent。
3. **不混合**。Refiner 不把"已有经验"当作它的搜索结果来回答当前问题；它只决定**新观察怎么
   沉淀进图**。召回（retrieve）是另一条路径。

---

## 2. 模型

图谱由三种对象构成：

| 对象 | 含义 | 存储 |
| --- | --- | --- |
| **Observation（观察）** | 一次原始输入（一条用户消息 + 当时的 agent 上下文快照） | `.opencode/refiner-memory/observations/<session_id>/<id>.md` |
| **Experience（经验）** | 从一条或多条 observation 中提炼出的可复用知识 | `.opencode/refiner-memory/experiences/<kind>/<id>.md` |
| **Edge（边）** | 两个 experience 之间的有向关系 | `.opencode/refiner-memory/graph.ndjson` |

配套文件：

- `taxonomy.json` — 记录已经出现过的 `custom:<slug>` kind 和 category slug 频次。
- `rejected.ndjson` — noise / 降级 / 守门拦截的审计流，追加写入，永不覆盖。
- `config.json` — refiner 的用户覆盖（模型路由、分类归一化等）。

### 2.1 Observation

```ts
type Observation = {
  id: string                       // `${session_id}:${message_id}:${ts}`
  observed_at: number
  session_id: string
  message_id: string               // 指向原始用户消息（可深链）
  user_text: string                // 原文
  source: "session" | "manual_augment" | "ingest"
  note?: string                    // 仅 manual_augment 使用，用户补充说明
  agent_context: {
    session_history_excerpt: Array<{
      role: "user" | "assistant"
      text: string
      message_id: string
    }>                             // 当前消息之前的最多 3 条
    workflow_snapshot?: {
      workflow_id: string
      node_id?: string
      phase?: string
      recent_events: Array<{ kind: string; at: number; summary: string }>
    }
  }
}
```

两条设计约束：

- **捕获是幂等的**：`captureObservation(session, message, text, observed_at, source)`
  是 live / ingest 共用的唯一入口，保证"历史导入"和"实时捕获"在字段上完全等价。
- **仅取前 3 条前文**：消息到达时后文尚未产生，不做异步补齐。若需要更早上下文，由 refiner
  在路由时通过只读工具 `get_session_history` 主动拉取。

### 2.2 Experience

```ts
type Experience = {
  id: string
  kind: CoreKind | `custom:${slug}`
  title: string                    // 名词短语；不以动宾结句
  abstract: string                 // 1–3 句提炼；保留规格 token，抽象叙事
  statement?: string               // 可选，机器可读陈述 e.g. "after:commit => require:lint"
  trigger_condition?: string
  task_type?: string
  scope: "workspace" | "project" | "repo" | "user"
  categories: string[]             // 0–4 个 kebab-case 标签
  observations: Observation[]
  related_experience_ids: string[] // 软关联；与 graph.ndjson 的 see_also 语义相同
  conflicts_with: string[]         // experience 级 soft marker
  refinement_history: Array<{
    at: number
    trigger_observation_id: string
    prev_snapshot?: { title; abstract; statement?; trigger_condition?; kind?; scope?; categories? }
    prev_abstract_digest?: string  // 前版 abstract 的 sha1 前 12 位（兼容旧行）
    kind?: "auto" | "manual_augment" | "manual_edit" | "merge" | "undo" | "re_refine"
    source_ids?: string[]
    model: string
  }>
  archived: boolean
  archived_at?: number
  created_at: number
  last_refined_at: number
}
```

`kind` 与 `categories` 是**正交**的：前者是认知形态（这是规则？还是领域事实？），后者是主题索引
（`git-workflow`、`compile-pipeline` …）。同一经验允许属于多个 categories，但只能归入一种 kind。

### 2.3 Edge

```ts
type Edge = {
  id: string                       // hash(from, to, kind)
  from: string                     // experience id
  to: string
  kind: "requires" | "refines" | "supports" | "contradicts" | "see_also"
  reason: string                   // ≤ 80 字中文
  confidence: number               // 0–1，默认 0.7
  created_at: number
  created_by: "llm_route" | "llm_refine" | "user_manual" | "system"
  source_observation_id?: string
}
```

---

## 3. Taxonomy

### 3.1 七个核心 kind

| kind | 定位 | 典型例子 |
| --- | --- | --- |
| `workflow_rule` | 流程规则（顺序/因果） | "commit 前必须跑 `pnpm lint`" |
| `workflow_gap` | 流程缺口 | "这里缺 gerrit 推送工具，需要 `git review -R`" |
| `know_how` | 操作性指导 | "用 `bun test --only` 跑单条用例" |
| `constraint_or_policy` | 硬约束/禁令 | "永远不动 `legacy/` 目录"；"UI 文字禁用 emoji" |
| `domain_knowledge` | 领域/事实 | "Q3 指 7-9 月"；"order-svc 仅部署在 UTC+8" |
| `preference_style` | 风格/偏好 | "代码注释用中文"；"commit message 不超 50 字" |
| `pitfall_or_caveat` | 常见坑/注意点 | "首次 `bun install` 会拉镜像，慢是正常的" |

### 3.2 动态扩展：`custom:<slug>`

当七类都不贴切且确实存在可复用模式时，LLM 可输出 `custom:<slug>`（小写 ascii、kebab-case、
≤ 24 字符，例如 `custom:env-setup`）。运行时把它记入 `taxonomy.json` 并在后续调用时把已知
custom slug 列表回喂给 LLM，避免重复造词。**不做自动晋升**：是否把常见 custom 提升为核心类，
是人工动作。

### 3.3 Categories（正交索引）

每条经验额外携带 0–4 个 category slug。运行时 `config.json` 支持 `category_aliases` 做归一化
（例如把 `git_workflow` 规范成 `git-workflow`），避免同义词打散图谱。

---

## 4. 边语义与图不变量

### 4.1 五种边

| 代码（存储） | 展示名 | 方向性 | 约束 | 常用意图 |
| --- | --- | --- | --- | --- |
| `requires` | 先决条件 | 严格有向 | **必须无环（DAG）** | "先完成 B 才能执行 A" |
| `refines` | 细化 | 严格有向 | **必须无环（DAG）** | "A 是 B 的特化版本" |
| `supports` | 支持 | 有向，允许回环 | — | "A 为 B 提供佐证" |
| `contradicts` | 冲突 | 存储有向，语义对称 | — | "A 与 B 直接矛盾" |
| `see_also` | 相关 | 弱方向 | — | "同话题可参考" |

展示名是 UI 和 hover card 默认读给用户看的标签；enum 值永远保持英文以稳定序列化。

### 4.2 写入时的不变量

```
tryApplyProposal(edges, proposal):
  if proposal.from == proposal.to             → drop (self_loop)
  if (from, to, kind) already exists           → idempotent skip
  if kind ∈ {requires, refines} AND cycle      → downgrade + log:
      requires → supports   (supports 允许回环)
      refines  → see_also   (弱关联)
  else                                          → append
```

批量提案（LLM 一次路由可提交最多 5 条边）走 `applyBatch`：逐条评估，整体写盘，个别失败不回滚
其他成功提案；守门降级与 dedup 都在内存快照里完成。

`pruneDangling(baseDir, aliveIDs)` 在 experience 被删除/归档时被调用，清理悬空的边；
`rewireEdges(from, to)` 在手动合并时把指向旧 id 的边改指向新 id。

---

## 5. 管道

```
observeUserMessage(sessionID, messageID)
      │
      ▼
 captureObservation  ──► 写 observation md 文件
      │
      ▼
 routeObservation (LLM, task: "route")
      │
      ├─ action: "noise"      → 追加 rejected.ndjson
      ├─ action: "edge_only"  → persistEdgeBatch（只加边）
      └─ action: "new"        → createExperience + （可选）persistEdgeBatch
                                         │
                                         ▼
                             attachAndRefine 可在后续通过
                             manual_augment / merge 再次触发
                                         │
                                         ▼
                             refineExperience (LLM, task: "refine")
                                         │
                                         ▼
                             写 experience md，追加 refinement_history
```

### 5.1 单次 route 可输出多项决定

LLM 返回的是 `{ decisions: [...] }`，一条用户消息若同时夹带多个**明确不同主题**（不同 kind 或
显著不同的指代对象）的想法，会被拆成多条决定，各自走 `new` / `edge_only` / `noise`。
拆分上限 8 条；不确定时倾向合并，避免出现近似重复的经验。

### 5.2 Attach 的弃用

早期版本允许 `action: "attach"` 把新观察挂到既有 experience 然后重炼。现在运行时**拒绝**
LLM 的 attach 输出：Prompt 不再宣告该分支，运行时若看到会降级为 noise 并写审计。只有**用户
手动操作**（merge、manual_augment）才会触发重炼。

这个决定的动机：LLM 的相似度判定在真实语料上过宽，反复 attach 会污染 abstract 向着平均意义漂
移。保留新建路径 + 人工合并，能得到更稳的图。

### 5.3 重炼的守门

`refineExperience` 产出的新 abstract 进入三道守门：

1. **等于原文**：`sha1(abstract) == sha1(user_text[:200])` ⇒ 视为退化，重试一次。
2. **结构化占位符**：以 `"见 observation"`、`"参考前述"` 等形式为主体 ⇒ 视为空壳，重试一次。
3. **两次失败**：回滚到上一版 snapshot，写 rejected.ndjson，不覆盖 experience。

历史每一次重炼都会在 `refinement_history` 中保留 `prev_snapshot`，因此 undo、diff、追溯都可
实现。

---

## 6. 规格 token 与过度抽象

Refiner 最典型的失败不是"不抽象"，而是"**抽象过头**"——把用户明确给出的命令、URL、Flag、环境
变量替换成"指定地址""特定命令"之类的空话，使得召回时什么也不剩。

规则拆成两层：

- **对叙事散文**：严禁连续 ≥ 10 个汉字（或 ≥ 8 个英文单词）直接从 `user_text` 抄写。要改写成
  可复用的"条件 + 规则"表述。
- **对规格 token**：`URL`、`path`、CLI 命令、flag、config key、环境变量名、稳定的标识符
  名词、带单位的阈值 —— **必须原样保留**，即使这意味着超过 10 字的连续抄写。

Prompt 里给的反例对照：

> ❌ "推送到指定的 gerrit 地址"
> ❌ "用户要求把当前分支 push 到 ssh://gerrit.example.com:29418/acme/core"
> ✅ "推送代码时使用 `git review -R`；远端为 `ssh://gerrit.example.com:29418/acme/core`"

可判断的分水岭：规格是否"反复可用"。稳定的 URL / 命令 / env 是可复用的；一次性 PR 编号、临时分支
名、工单号 不是——它们应该被判 `noise`。

---

## 7. 冲突标记

有两套冲突标记，彼此独立，**可共存**：

- **Experience 级 `conflicts_with: string[]`** — 软标记。当新建或重炼时，LLM 觉察与某已有条目
  直接矛盾，就把被矛盾项的 id 加进来。不会自动裁决；UI 上以徽标提示。
- **Edge 级 `contradicts`** — 显式方向性标注。和其他边一起存进 `graph.ndjson`，在图谱里可视化。

哪个用？能给出**方向性理由**（"A 声称永不 force push，但 B 要求 force push 用于 hotfix"）就用
`contradicts`；只是标记"这两条互斥，具体怎么选由人决定"就用 `conflicts_with`。

---

## 8. 召回组合（读路径）

召回不是 Refiner agent 内部动作，但图谱设计必须支持它。组合规则：

1. 按 `categories` / `task_type` / `scope` 过滤候选集合。
2. 对每条候选经验，按 `last_refined_at` 取 Top-N summary 注入。
3. 对每条被选中的经验，**沿 `requires`、`refines` 边展开 1 层**，把先决条件/细化子项一并带入。
4. `contradicts` 与 `conflicts_with` 作为警示区块，不参与主注入流。
5. `see_also` 只有在用户主动查看时才展开（UI hover），注入链路默认忽略。

在 UI 层，节点 hover 卡按相同的边语义生成中文叙事：

| 边 | 自身指向对端（out） | 对端指向自身（in） |
| --- | --- | --- |
| `requires` | 先完成「B」，再执行「A」 | 「B」依赖本条，需先确保「A」成立 |
| `refines` | 「A」是对「B」的细化/特化 | 「B」对本条做了进一步细化 |
| `supports` | 「A」可作为「B」的佐证 | 「B」为本条提供支持证据 |
| `contradicts` | 注意：「A」与「B」存在冲突 | 注意：「B」与本条存在冲突 |
| `see_also` | 同话题可参考「B」 | 同话题可参考「B」 |

---

## 9. LLM 压力与预算

一次 route 调用最大上下文含：

- 一条 observation（+ 前 3 条 history + workflow 快照）。
- 最多 N 条 experience summary（`id / kind / title / abstract / task_type / observation_count /
  last_refined_at`）。
- taxonomy 列表（7 核心 + 已知 custom + 已知 categories）。
- 7 类 kind 和 5 类 edge 的中文释义。

实际测试下来，N = 50 左右可稳定塞入 32k-window 的模型；更大规模时需要：

1. 用 `last_refined_at` 降序 + `task_type` 加权选 Top-N。
2. 其余以 `"(omitted N, use get_experience_detail to pull)"` 提示 LLM 按需调用工具。
3. Summary 里的 `title ≤ 30` 字、`abstract ≤ 200` 字是硬截断，就是为了保住预算。

对"能不能一次组合多条边"的压力评估：Prompt 允许每次 route **最多 5 条边**；实际 decisions[]
上限 8 条，5×8 = 40 条边是硬顶。超过时应分多次会话提交，而不是在一次调用里堆叠。

---

## 10. 触发与摄入入口

当前只有两个写入触发：

1. **`observeUserMessage`**（live）—— 每条用户消息触发。Master→Slave 生成的 prompt 因为
   `Session.parentID != null` 会被过滤掉，避免把编排器的话当成用户输入。
2. **`ingestSession` / history import**（batch）—— 用户显式从历史会话里 cherry-pick 消息注入。
   字段等价于 live 捕获，只是 `source: "ingest"` 且通常没有 `workflow_snapshot`。

被明确**不做**的触发：

- `observeWorkflowEvent`（node.failed / workflow.completed 等）—— 一度设计过，现已删除。workflow
  事件要沉淀成经验，必须先由用户在 slave session 里把它描述清楚，再走标准捕获路径。避免
  runtime 噪音淹没用户意图。

---

## 11. 目录与文件布局

```
.opencode/refiner-memory/
├── experiences/
│   ├── workflow_rule/          <id>.md
│   ├── workflow_gap/           <id>.md
│   ├── know_how/               <id>.md
│   ├── constraint_or_policy/   <id>.md
│   ├── domain_knowledge/       <id>.md
│   ├── preference_style/       <id>.md
│   ├── pitfall_or_caveat/      <id>.md
│   └── custom:<slug>/          <id>.md
├── observations/<session_id>/  <id>.md
├── graph.ndjson                # 每行一条 Edge
├── taxonomy.json               # { custom_kinds: [...], categories: [...] }
├── rejected.ndjson             # noise / 守门拒绝 / 降级 审计
└── config.json                 # 用户覆盖（模型、category aliases 等）
```

Experience 和 observation 都是 YAML frontmatter + markdown body 的结构化文件，body 部分是
`renderExperience` / `renderObservation` 产出的人类可读概要；frontmatter 是权威数据，反序列化由
Zod schema 保证。

---

## 12. 设计取舍小结

| 取舍 | 选择 | 为什么 |
| --- | --- | --- |
| 记忆形态 | 图谱（典型节点 + 类型边），**不是**扁平列表 | 先决条件/细化这种依赖关系本质是关系数据；扁平化会把所有推理成本推给召回端 |
| 存储 | YAML + markdown + NDJSON，**不是**SQLite | 经验必须人工可读/可编辑；图谱规模远未到需要关系型的程度 |
| 相似度合并 | 只由用户触发，**LLM 不做 attach** | 自动合并会缓慢腐蚀 abstract；代价是图可能有近似重复，用人工合并能精准修复 |
| kind 体系 | 7 核 + `custom:<slug>` | 核心类覆盖日常 >90%；custom 是扩展通道而不是兜底箱 |
| categories | 独立于 kind 的多值索引 | 一条"commit 前必跑 lint"既属于 `workflow_rule`，又属于 `git-workflow` + `ci-pipeline`，用单一分类强行坍缩会丢掉召回面 |
| 规格 token | 必须原样保留 | 抽象的目的是召回时还能被复用；抽掉 URL/命令就失去了这份经验存在的理由 |
| history 前文 | 固定 3 条前文 + 工具按需 | 异步补全后文会导致状态机爆炸；LLM 需要更多时可主动拉 |
| 冲突处理 | 标记不裁决 | Refiner 不掌握业务优先级，强行择一会造成静默覆盖 |
