# RAG 渐进式披露当前实现说明

## 1. 范围

这份文档描述当前代码里的真实实现，不是理想设计。

当前“渐进式披露”系统由三部分组成：

1. 自动注入：`.opencode/plugins/rag_context.ts`
2. 显式检索工具：`.opencode/tool/rag_search.ts`
3. 共享状态与公共逻辑：`.opencode/rag.ts`

底层检索脚本仍然是：

1. `script/rag/search-vector-index.py`

## 2. 当前目标

当前实现要解决的是：

1. 在 ReAct 式 loop 中持续给模型提供检索状态
2. 不在每一轮 loop 中重复注入相同正文
3. 把 `rag_context` 和 `rag_search` 统一为同一套渐进式披露系统
4. 提供可追踪的 JSONL 调试日志

## 3. 当前架构

### 3.1 自动注入链路

`rag_context` 当前只负责注入检索 meta 信息，不再自动注入正文摘要。

它每次在 `experimental.chat.messages.transform` 被调用时会：

1. 找到当前会话里最新的 user text
2. 去掉旧的 `<rag_state>` / `<rag_context>`
3. 生成 query cluster
4. 查询共享状态
5. 必要时调用底层检索脚本
6. 只把 `<rag_state>` 注回用户消息

这意味着：

1. 模型在 loop 中每一步都能看到当前的 RAG 状态
2. 是否继续调 `rag_search`，由模型自己判断

### 3.2 显式工具链路

`rag_search` 当前负责渐进式补充证据。

支持模式：

1. `state`
2. `delta`
3. `brief`
4. `expand`

推荐顺序：

1. `state`
2. `delta`
3. `brief`
4. `expand`

其中：

1. `state` 只返回状态
2. `delta` 只返回新增证据
3. `brief` 返回短摘要
4. `expand` 返回扩展文本，默认受限

### 3.3 共享状态

自动注入和显式工具现在都使用同一个共享状态模块：

1. `.opencode/rag.ts`

共享状态粒度是：

1. `session`
2. `cluster`

每个 cluster 当前维护的信息包括：

1. `seen`
2. `window`
3. `last_query`
4. `last_status`
5. `last_reason`
6. `last_checked`
7. `total_hits`
8. `known_hits`
9. `overlap`
10. `delta`
11. `hits`
12. `top`
13. `rewrites`

因此当前 `rag_context` 和 `rag_search` 已经不是两套独立状态机，而是同一状态系统的两个入口。

## 4. 自动注入的当前规则

### 4.1 注入内容

自动注入当前只注入：

1. `<rag_state>`

不再自动注入正文 `<rag_context>`。

这样做的目的：

1. 让模型在每一步都能看到检索状态
2. 把正文披露权交给 `rag_search`
3. 避免 loop 中重复刷证据文本

### 4.2 何时触发

自动注入不是只在“用户第一次提问”时触发。

当前实现里，只要：

1. `experimental.chat.messages.transform` 被调用
2. 最新 user text 还存在

插件就会再次运行。

区别在于：

1. 首次进入当前 query 时，通常会实际检索
2. 后续 loop 更常见的是复用共享状态，只重新注入 `<rag_state>`

### 4.3 缓存与复用

自动注入会优先复用共享状态，条件包括：

1. 同一 user query
2. 同一 cluster
3. 在 `RAG_REUSE_SEC` 时间窗内
4. 或已经进入 assistant loop 阶段

如果命中缓存，插件不会重新检索，而是直接注入当前 cluster 的状态。

### 4.4 局部限流

每个 cluster 单独维护时间窗：

1. `RAG_CLUSTER_WINDOW_SEC`
2. `RAG_CLUSTER_MAX_FULL`

超过上限后，状态会变成：

1. `cluster_throttled`

## 5. 当前状态机

当前状态枚举：

1. `new_evidence`
2. `no_new_evidence`
3. `weak_match`
4. `need_refine`
5. `cluster_throttled`
6. `retrieval_error`
7. `state_reset`

典型 reason：

1. `fresh_hits`
2. `delta_available`
3. `high_overlap`
4. `low_score`
5. `empty_hits`
6. `cluster_window_limit`
7. `backend_error`
8. `parse_error`
9. `cached_recent_result`
10. `compaction_epoch_changed`

## 6. 什么叫“渐进式披露”

### 6.1 自动注入侧

自动注入侧的渐进式披露体现在：

1. 首轮只建立状态并记录 hits
2. 后续 loop 主要复用状态
3. 自动注入不再负责正文披露

换句话说，当前自动注入承担的是：

1. 渐进提供 meta

而不是：

1. 渐进提供正文

### 6.2 工具侧

显式工具侧的渐进式披露体现在：

1. `state` 只给状态
2. `delta` 只给新增证据
3. `brief` 给短摘要
4. `expand` 给更多文本

这才是当前正文证据的主要披露链路。

## 7. Query Cluster

当前 cluster 生成方式：

1. query 小写化
2. 中英文词项切分
3. 去停用词
4. 同义词归一
5. 排序拼接

作用：

1. 把近义问题归到同一局部检索意图
2. 支持同 cluster 去重
3. 支持同 cluster 限流

## 8. 底层检索脚本的当前角色

`search-vector-index.py` 仍然只负责：

1. embedding query
2. 检索向量库
3. 返回 hits

当前输出格式支持：

1. `json`
2. `state`
3. `brief`
4. `auto`

当前约束：

1. `rag_context` 强制 `--format json`
2. `rag_search` 也强制 `--format json`
3. 只有 shell 直接运行脚本时，`OPENCODE=1` 下默认输出 `state`

这样做是为了：

1. 插件和工具都自己控制披露层级
2. 终端里不要直接泄漏 hits 正文

### 8.1 当前 rewrite 与 multi-query 检索

当前底层检索脚本已经支持：

1. LLM query rewrite
2. multi-query retrieval
3. merge 去重
4. simple rerank

流程如下：

1. 原始 query 输入
2. LLM 产出 `queries` 和 `keywords`
3. 每个 rewrite query 单独向量检索
4. 多路结果按 fingerprint merge
5. 用简单规则做 rerank
6. 输出最终 `top_k`

当前 rerank 不是独立 reranker 模型，而是规则组合：

1. `max_score`
2. `reciprocal_rank`
3. `hit_count`
4. `primary_match`

## 9. 调试日志

### 9.1 日志文件

当前统一日志：

1. `.rag/log/rag_debug.jsonl`

### 9.2 当前记录的链路

现在会同时记录：

1. `rag_context`
2. `rag_search`

通过字段区分：

1. `channel`
2. `event`

### 9.3 当前重点字段

当前日志里重点字段包括：

1. `channel`
2. `event`
3. `sessionID`
4. `query`
5. `cluster`
6. `mode`
7. `loop`
8. `used_cache`
9. `status`
10. `reason`
11. `total_hits`
12. `delta_hits`
13. `known_hits`
14. `overlap`
15. `rewrites`
16. `keywords`
17. `rewrite_mode`
18. `top_hits`
19. `delta_fps`
20. `emitted_context`

### 9.4 当前怎么判断渐进式披露生效

看同一 `sessionID + cluster` 的连续日志：

1. 首次检索：
   - `status=new_evidence`
   - `delta_hits>0`
2. 后续 loop：
   - `channel=rag_context`
   - `event=context_meta`
   - `used_cache=true`
3. 后续主动补证据：
   - `channel=rag_search`
   - `event=tool_search`
   - `mode=delta|brief|expand`

这说明当前系统是在“先提供状态，再按需补正文”。

## 10. 终端与 TUI 控制

当前实现已经做了三层控制：

1. 检索子进程使用 `.quiet()`
2. shell 直接跑脚本时默认只输出 `state`
3. `expand` 默认受限

当前目标不是完全隐藏检索，而是：

1. 不让底层脚本 stdout 直接污染终端
2. 不让自动注入链路在 loop 中刷大段正文

## 11. 当前限制

1. 自动注入只提供 meta，不提供正文，需要模型自行决定是否调 `rag_search`
2. 还没有 decomposition
3. 当前 rerank 还是简单规则，不是专门 reranker 模型
4. debug 已能看到 top hits 和 delta 指纹，但还没有记录 assistant reasoning 原文
5. 多模态 embedding 还未接入当前渐进披露链路

## 12. 关键代码锚点

1. 共享状态：`.opencode/rag.ts`
2. 自动注入：`.opencode/plugins/rag_context.ts`
3. 渐进检索工具：`.opencode/tool/rag_search.ts`
4. 底层检索：`script/rag/search-vector-index.py`
5. 调试查看：`script/rag/debug-rag-state.py`
