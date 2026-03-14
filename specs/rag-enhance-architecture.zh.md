# RAG Enhance 架构设计说明（rag-enhance）

## 1. 目标与设计原则

### 1.1 目标

1. 在 OpenCode 对话中提供稳定的本地 RAG 能力（内网可部署）
2. 降低重复检索与重复注入导致的推理循环
3. 控制上下文窗口占用，优先增量披露
4. 提供可观测调试手段，便于快速定位问题

### 1.2 原则

1. 优先改插件与脚本，不侵入 opencode core
2. 结构化协议先行（`<rag_state>` + `<rag_context>`）
3. 去重与增量优先于硬编码“单次限制”
4. 参数可配置，默认值保守

## 2. 总体架构

### 2.1 模块分层

1. 数据准备层：`script/rag/url-to-text.sh`、`convert-dir-to-text.sh`、`clean-text.py`
2. 结构化层：`script/rag/structure-text.py`（rule/llamaindex）
3. 向量索引层：`script/rag/build-vector-index.py` + Qdrant local
4. 检索层：`script/rag/search-vector-index.py`
5. 编排层：`script/rag/rag-pipeline.py` + `cmd/rag-init.sh`/`cmd/rag-update.sh`
6. 交互层：
   - 自动注入插件：`.opencode/plugins/rag_context.ts`
   - 手动工具：`.opencode/tool/rag_search.ts`
   - 共享状态模块：`.opencode/rag.ts`

### 2.2 运行路径

1. 离线/内网数据进入文本化
2. 文本结构化为 section/chunk/image 节点
3. embedding 写入 Qdrant（payload 包含 source、section、doc_key 等）
4. 对话时：插件读取检索结果并注入状态 meta
5. 长 query 会先执行 rewrite + multi-query retrieval + merge/rerank
6. 模型必要时再调用 `rag_search(mode=state|delta|brief|expand)` 渐进补证据

## 3. 文档处理与切分策略

### 3.1 当前切分策略

1. 按 Markdown 标题（`#`）拆 section
2. section 内按固定窗口切 chunk（默认 `chunk_size=1600`, `chunk_overlap=200`）
3. 图片 OCR 独立为 image node，避免污染正文 chunk

说明：当前不是句法感知切分，`overlap` 用于缓解边界截断，但不能完全消除语义断裂。

### 3.2 结构化与 LLM

1. `structure-text.py` 直接执行时默认 `mode=rule`
2. `rag-pipeline.py` 默认 `RAG_STRUCT_MODE=llamaindex`
3. llamaindex 模式下调用 OpenAI 兼容接口做 section summary

## 4. 检索交互协议（RAG-LLM）

### 4.1 注入块

插件当前向用户消息注入一个主逻辑块：

1. `<rag_state>`：检索状态协议（短）

说明：正文证据当前主要通过 `rag_search` 渐进披露，不再由自动注入直接提供。

示例：

```text
<rag_state>
status=no_new_evidence
reason=high_overlap
cluster=luckfox|zero|烧录
delta_hits=0
known_hits=3
next_action=reuse_known_evidence_or_refine_query
</rag_state>
```

### 4.2 status 枚举

1. `new_evidence`
2. `no_new_evidence`
3. `weak_match`
4. `need_refine`
5. `cluster_throttled`
6. `retrieval_error`
7. `state_reset`

### 4.3 reason 典型值

1. `fresh_hits`
2. `delta_available`
3. `high_overlap`
4. `low_score`
5. `empty_hits`
6. `cluster_window_limit`
7. `backend_error`
8. `parse_error`
9. `compaction_epoch_changed`
10. `cached_recent_result`

## 5. 去重、增量与局部限流

### 5.1 Query Cluster

`query_cluster` 为“检索意图簇”，由 query 规范化词项生成（停用词过滤+同义词归一+排序）。

用途：

1. 将近义 query 归为同簇
2. 对同簇做局部预算与节流
3. 避免全局限流误伤其他主题

### 5.2 重复检测

1. 命中 fingerprint：`text_file/source + chunk_id/image_id/section`
2. overlap = 交集 / 当前命中数
3. `overlap >= RAG_OVERLAP_THRESHOLD` 且无新增时，标记 `no_new_evidence`

### 5.3 增量注入

1. 仅注入“未见过”的 delta hits
2. 无 delta 时只注入 `<rag_state>`，不重复注入上下文正文
3. 同 query 的短时间重复触发走缓存复用（`RAG_REUSE_SEC`）

### 5.4 局部限流

1. 仅针对同一 cluster
2. 时间窗：`RAG_CLUSTER_WINDOW_SEC`
3. 上限：`RAG_CLUSTER_MAX_FULL`
4. 超限状态：`cluster_throttled`

## 6. 渐进式披露

`rag_search` 支持模式：

1. `state`：只返回检索状态
2. `delta`：同 query cluster 仅新增证据（默认）
3. `brief`：当前命中的短摘要
4. `expand`：扩展细节（用于二次追问）

策略：

1. 默认由插件持续注入 `rag_state`
2. 模型需要证据时优先 `delta`
3. `brief`/`expand` 仅在需要更多正文时使用

## 7. 会话生命周期与 compact

### 7.1 loop 触发

OpenCode loop 每步都会触发 `experimental.chat.messages.transform`，因此插件必须具备状态机去重能力。

### 7.2 compaction 重置

插件实现 `experimental.session.compacting`：

1. session `epoch + 1`
2. 清空 seen hit 与 cluster 窗口
3. 标记 `state_reset`

目的：防止 compaction 后继续引用旧上下文状态。

## 8. 配置参数

### 8.1 基础连接

1. `OPENAI_BASE_URL` / `OPENAI_API_KEY`
2. `RAG_BASE_URL` / `RAG_API_KEY`（覆盖）
3. `RAG_WORKTREE`
4. `RAG_DOCLING_PYTHON_BIN`
5. `RAG_DB_PATH`

### 8.2 检索与注入

1. `RAG_TOP_K`（默认 4）
2. `RAG_CONTEXT_HITS`（默认 2）
3. `RAG_CONTEXT_CHARS`（默认 120）
4. `RAG_EXPAND_CHARS`（默认 420）
5. `RAG_REWRITE_MODE`（默认 `auto`）
6. `RAG_REWRITE_MODEL`
7. `RAG_REWRITE_QUERIES`（默认 3）

### 8.3 控制与阈值

1. `RAG_AUTO_INJECT`（`0` 关闭）
2. `RAG_OVERLAP_THRESHOLD`（默认 0.8）
3. `RAG_WEAK_SCORE`（默认 0.42）
4. `RAG_CLUSTER_WINDOW_SEC`（默认 30）
5. `RAG_CLUSTER_MAX_FULL`（默认 2）
6. `RAG_REUSE_SEC`（默认 8）

### 8.4 调试

1. `RAG_DEBUG=1` 或 `RAG_DEBUG_LOG=1`
2. 日志：`.rag/log/rag_debug.jsonl`
3. 查看：`script/rag/debug-rag-state.py --tail 100`

## 9. 典型问题与解决方案

### 9.1 问题：循环检索与重复思考

原因：loop 多步触发 + 命中不充分 + 无状态去重。

解决：

1. `query_cluster` 局部限流
2. overlap 去重
3. delta 注入
4. cache reuse

### 9.2 问题：TUI 回显过多

原因：工具多轮调用 + 大块文本注入。

解决：

1. 默认 `brief`
2. `RAG_CONTEXT_HITS` 降低
3. 强制“禁止 dump 原始 JSON/rag_context”系统提示
4. 必要时仅保留 plugin，禁用显式 `rag_search`

### 9.3 问题：手工命令成功但插件失败

常见：worktree 识别为 `/`。

解决：

1. 显式配置 `RAG_WORKTREE`
2. 显式配置 `RAG_DOCLING_PYTHON_BIN`
3. 显式配置 `RAG_DB_PATH`

### 9.4 问题：compaction 后行为异常

原因：检索状态与压缩后消息不一致。

解决：

1. 在 `experimental.session.compacting` 事件重置 RAG 状态

## 10. 运维与回归检查清单

1. 检索可用：`search-vector-index.py` 手工命令返回 hits
2. 集合存在：Qdrant `rag_chunks` 可见
3. 插件注入：日志出现 `event=inject`
4. 无新增命中：出现 `status=no_new_evidence`
5. 局部限流触发：出现 `event=cluster_throttled`
6. compact 后：出现 `event=state_reset`

## 11. 代码锚点（便于回溯）

1. 自动注入状态机：`.opencode/plugins/rag_context.ts`
2. 工具渐进披露：`.opencode/tool/rag_search.ts`
3. 调试脚本：`script/rag/debug-rag-state.py`
4. 结构化切分：`script/rag/structure-text.py`
5. 编排入口：`script/rag/rag-pipeline.py`

## 12. 后续可演进方向

1. 语义切分（句法/段落边界）替代纯字符窗口
2. query cluster 从词法升级到 embedding 聚类
3. reranker 引入（重排 top-k）
4. `expand` 模式支持按 `chunk_id` 精确拉取
5. 将状态机下沉到独立模块，支持单元测试
