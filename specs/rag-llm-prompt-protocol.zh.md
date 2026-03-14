# RAG 输出给 LLM 的当前协议

## 1. 范围

这份文档只描述当前代码里真正输出给 LLM 的内容，不描述 debug 日志，也不描述理想设计。

当前协议由三部分组成：

1. 自动注入的 `<rag_state>`
2. 系统提示里的 RAG 协议说明
3. `rag_search` 工具定义与工具返回

相关实现文件：

1. `.opencode/rag.ts`
2. `.opencode/plugins/rag_context.ts`
3. `.opencode/tool/rag_search.ts`

## 2. 自动注入块

### 2.1 注入位置

`rag_context` 会在 `experimental.chat.messages.transform` 阶段，把 `<rag_state>` 注入到当前最新的 user text 中。

当前默认行为：

1. 自动注入只注入检索 meta
2. 不自动注入正文 `<rag_context>`
3. 正文证据主要由 `rag_search` 按需补充

### 2.2 当前字段

当前注入给 LLM 的 `<rag_state>` 字段来自 `.opencode/rag.ts` 的 `stateBlock()`：

```text
<rag_state>
status=...
reason=...
cluster=...
total_hits=...
delta_hits=...
known_hits=...
overlap=...
top_source=...
top_section=...
rewrite_queries=...
next_action=...
</rag_state>
```

字段含义：

1. `status`
   当前 `session + cluster` 最近一次有效检索状态
2. `reason`
   对应状态的原因
3. `cluster`
   当前 query 归一化后的检索意图簇
4. `total_hits`
   当前最近一次检索返回的总命中数
5. `delta_hits`
   相对当前 cluster 已知证据，本轮新增命中数
6. `known_hits`
   当前 cluster 已记录的累计命中数
7. `overlap`
   本轮结果和已知命中的重合比例
8. `top_source`
   当前 top hit 的来源 URL
9. `top_section`
   当前 top hit 的 section 标题
10. `rewrite_queries`
   当前底层检索实际使用的 rewrite query 列表
11. `next_action`
   给 LLM 的下一步建议动作

### 2.3 当前不输出给 LLM 的字段

下面这些字段当前只写入 debug 日志，不直接注入给 LLM：

1. `event`
2. `channel`
3. `loop`
4. `used_cache`
5. `rewrite_mode`
6. `keywords`
7. `top_hits`
8. `delta_fps`
9. `emitted_context`

因此，LLM 不会直接看到“这一步是 `context_search` 还是 `context_meta`”，也不会直接看到完整 hit 列表。

## 3. 系统提示协议

`rag_context` 还会在 `experimental.chat.system.transform` 中追加 RAG 协议说明。

当前系统提示的核心约束是：

1. 每一步先解析 `<rag_state>`
2. `rag_context` 只注入 retrieval meta，不注入正文
3. 如果 `status=new_evidence` 且仍需要事实细节，优先调用 `rag_search mode=delta`
4. 如果 `status=no_new_evidence`，优先复用当前状态，不要重复检索
5. 普通问答不要调用 `mode=expand`
6. 不要直接通过 shell 执行 `script/rag/search-vector-index.py` 做问答检索
7. 调用 `rag_search` 时，参数必须是合法 JSON
8. 对于长 query 或噪声 query，优先信任 rewrite 后的检索结果

这部分不是结构化字段，而是对 LLM 的操作协议说明。

## 4. `rag_search` 工具协议

### 4.1 工具入参

当前 `rag_search` 暴露给 LLM 的主要入参是：

1. `query`
2. `top_k`
3. `node_type`
4. `mode`

其中：

1. `query` 是普通字符串
2. `top_k` 是返回条数
3. `node_type` 目前主要是 `text` 或 `image`
4. `mode` 控制渐进式披露层级

### 4.2 工具模式

当前支持的模式：

1. `state`
2. `delta`
3. `brief`
4. `expand`

推荐顺序：

1. `state`
2. `delta`
3. `brief`
4. `expand`

默认约束：

1. 普通 QA 下优先 `delta`
2. `expand` 默认受限，仅用于调试或显式证据展开

### 4.3 工具返回

`rag_search` 的返回不是原始 JSON，而是给 LLM 的文本协议。

当前工具返回的第一部分始终是：

1. `<rag_state>`

然后按 `mode` 决定是否追加正文：

1. `state`
   只返回 `<rag_state>`
2. `delta`
   返回 `<rag_state>` + 本轮新增命中的短摘要
3. `brief`
   返回 `<rag_state>` + 当前命中的短摘要
4. `expand`
   返回 `<rag_state>` + 更长文本

### 4.4 摘要格式

`brief` 和 `delta` 当前使用 `.opencode/rag.ts` 里的 `brief()` 生成，格式类似：

```text
[1] source=... section=... summary=...
[2] source=... section=... summary=...
```

`expand` 当前使用 `.opencode/rag.ts` 里的 `expand()`，会给更长的 `score/source/section/text`。

## 5. LLM 实际看到的内容

从 prompt 协议角度看，LLM 当前会看到三类信息：

1. 用户原始问题
2. 自动注入的 `<rag_state>`
3. 系统提示里的 RAG 使用规则

如果模型主动调用 `rag_search`，还会额外看到：

1. 工具参数 schema
2. 工具返回的 `<rag_state>`
3. 工具返回的摘要或扩展正文

因此当前架构下：

1. 自动注入负责给状态
2. 工具调用负责给正文

## 6. 当前典型工作流

### 6.1 自动注入阶段

模型先看到：

```text
用户问题

<rag_state>
status=new_evidence
reason=fresh_hits
cluster=luckfox|文件传输
total_hits=4
delta_hits=4
known_hits=4
overlap=0.0000
top_source=https://wiki.luckfox.com/...
top_section=ADB 传输文件
rewrite_queries=["Luckfox Pico Zero 文件传输","adb 文件传输"]
next_action=call_rag_search_delta_if_more_detail_needed
</rag_state>
```

这时模型应该先基于状态判断：

1. 是否已有足够信息直接回答
2. 是否需要调用 `rag_search mode=delta`
3. 是否应该缩小或改写 query

### 6.2 工具补充阶段

如果模型调用：

```json
{"query":"Luckfox Pico Zero 文件传输方式","mode":"delta","node_type":"text","top_k":4}
```

它会看到类似返回：

```text
<rag_state>
status=new_evidence
reason=delta_available
cluster=luckfox|文件传输方式
total_hits=4
delta_hits=2
known_hits=6
overlap=0.5000
top_source=https://wiki.luckfox.com/...
top_section=ADB 传输文件
rewrite_queries=["Luckfox Pico Zero 文件传输方式","adb push pull 文件传输"]
next_action=call_rag_search_delta_if_more_detail_needed
</rag_state>
[1] source=https://wiki.luckfox.com/... section=ADB 传输文件 summary=...
[2] source=https://wiki.luckfox.com/... section=SCP 传输文件 summary=...
```

这时模型拿到的就不只是状态，还有正文摘要。

## 7. 当前语义边界

### 7.1 `status` 的语义

当前 `<rag_state>.status` 表示：

1. 当前 `session + cluster` 最近一次有效检索结果的状态

它不等价于：

1. “当前这一个 loop step 刚刚重新搜索得到的新状态”

因此，如果当前 step 只是复用了缓存状态，LLM 看到的 `status=new_evidence`，实际语义更接近：

1. 当前 cluster 的已知状态是 `new_evidence`

而不是：

1. 本 step 又重新找到了新证据

### 7.2 `next_action` 的语义

`next_action` 是建议，不是硬约束。

LLM 仍然可以：

1. 直接回答
2. 选择更具体的 query
3. 调 `rag_search`
4. 放弃继续检索

但系统提示已经对推荐行为做了收敛。

## 8. 当前已知限制

1. `event/context_meta/context_search` 只在 debug 日志里，LLM 不可见
2. LLM 不能直接看到完整命中列表，除非主动调用 `rag_search`
3. `status` 当前更接近 cluster 持久状态，不是严格的 step 状态
4. 自动注入与工具调用虽然共享状态，但 query cluster 仍可能因为 agent rewrite 而不同

## 9. 结论

当前真正输出给 LLM 的协议可以概括为：

1. 自动注入 `<rag_state>` 提供检索 meta
2. 系统提示解释如何使用这些 meta
3. `rag_search` 提供分层的正文证据披露

因此，当前系统不是“自动把所有 RAG 内容都塞进 prompt”，而是：

1. 先给状态
2. 再由模型按需索取正文

