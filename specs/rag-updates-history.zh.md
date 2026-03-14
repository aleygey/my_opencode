# RAG Enhance 变更回溯记录

## 1. 目的

这份文档用于记录本分支上 RAG 增强相关的关键演进，方便后续回溯问题来源、定位设计变更和重新部署时核对差异。

## 2. 第一阶段：基础 RAG 流水线落地

这一阶段完成了基础数据链路：

1. 文档转文本
2. 文本清洗
3. 结构化输出
4. embedding 落库
5. 本地向量检索

主要脚本：

1. `script/rag/url-to-text.sh`
2. `script/rag/convert-dir-to-text.sh`
3. `script/rag/clean-text.py`
4. `script/rag/structure-text.py`
5. `script/rag/build-vector-index.py`
6. `script/rag/search-vector-index.py`

## 3. 第二阶段：OpenCode 插件化接入

这一阶段引入了 OpenCode 集成层：

1. 自动注入插件：`.opencode/plugins/rag_context.ts`
2. 手动工具：`.opencode/tool/rag_search.ts`
3. skill：`.opencode/skills/rag-pipeline/SKILL.md`

目标是：

1. 让 agent 在对话中可使用本地 RAG
2. 支持插件迁移到其他项目
3. 用 `rag-bootstrap.sh` / `install.sh` 完成交付

## 4. 第三阶段：图片 OCR 与结构化关联

这一阶段处理了图片与正文的关联问题：

1. 图片 OCR 从纯追加文本改成与 image node 关联
2. 结构化输出中保留 image metadata
3. 向量检索命中正文时，可挂出 `related_images`

目标是：

1. 不直接污染正文 section
2. 在命中 chunk 时仍然能关联图片信息

## 5. 第四阶段：初版渐进式披露

这一阶段第一次引入：

1. `<rag_state>`
2. `<rag_context>`
3. overlap 去重
4. cluster 局部限流
5. debug 日志

初版实现特点：

1. 自动注入会注入状态和正文摘要
2. `rag_search` 自己维护一套独立状态
3. debug 主要看状态，证据可见性较弱

当时解决的问题：

1. 检索循环
2. 重复注入
3. context 窗口浪费

## 6. 第五阶段：终端/TUI 回显治理

这一阶段重点修了“检索输出污染终端/TUI”的问题。

核心修复：

1. `rag_search.ts` 和 `rag_context.ts` 调检索脚本时补 `.quiet()`
2. 两条链路都强制 `search-vector-index.py --format json`
3. `search-vector-index.py` 在 `OPENCODE=1` 下默认只输出 `state`
4. `rag_search expand` 默认拦截

目标是：

1. 检索子进程不再把 stdout 直接打印到终端
2. 工具链路不再因为 parse fail 回退成整段文本回显

## 7. 第六阶段：非法 JSON tool args 缓解

这一阶段修复了模型调用 `rag_search` 时偶发生成坏 JSON 的问题。

核心修复：

1. 在 `tool.definition` 中补充合法/非法 JSON 示例
2. 在 system prompt 中明确要求 `query` 必须是单个普通字符串

目标是：

1. 降低模型把 query 引号拼坏的概率

注意：

1. 这类问题是模型生成错误，无法 100% 从代码层彻底消除

## 8. 第七阶段：共享状态统一

这一阶段把 `rag_context` 和 `rag_search` 统一进同一套共享状态系统。

新增文件：

1. `.opencode/rag.ts`

统一后：

1. 两条链路共享 session/cluster 状态
2. 共享 `seen`
3. 共享 `total_hits / known_hits / overlap`
4. 共享 `top_hits`
5. 共享 `rewrites`

这一阶段的设计变化很关键：

1. `rag_context` 不再自动注入正文，只注入检索 meta
2. `rag_search` 成为正文证据的渐进式补充入口

## 9. 第八阶段：ReAct loop 对齐

这一阶段是为适配 OpenCode 的 ReAct 式 loop。

变化点：

1. `rag_context` 不再只在“第一次用户提问前”工作
2. 在 loop 中也会再次运行
3. 但后续更常见的是复用缓存状态，只重复注入 `<rag_state>`

目标是：

1. 在推理过程中让模型持续看到当前检索状态
2. 由模型自行决定是否继续调用 `rag_search`

## 10. 第九阶段：debug 日志增强

这一阶段把 debug 从“状态日志”增强成“过程日志”。

现在统一记录到：

1. `.rag/log/rag_debug.jsonl`

日志覆盖：

1. `rag_context`
2. `rag_search`

主要新增字段：

1. `channel`
2. `mode`
3. `loop`
4. `used_cache`
5. `top_hits`
6. `delta_fps`
7. `rewrites`
8. `emitted_context`

目的：

1. 可追踪每一次状态注入
2. 可追踪每一次显式检索
3. 可回溯当前 cluster 的命中情况

## 11. 第十阶段：query rewrite 与 multi-query retrieval

这一阶段在底层检索脚本里加入了：

1. LLM query rewrite
2. 多 query 独立召回
3. merge 去重
4. simple rerank

当前实现方式：

1. LLM 输出 `queries` 和 `keywords`
2. 每个 query 单独做 embedding 检索
3. 按 chunk fingerprint 合并候选
4. 结合 `max_score / reciprocal_rank / hit_count / primary_match` 做重排

目标是：

1. 降低长 query 的语义噪声
2. 提高多视角召回能力
3. 给后续 decomposition 留出接口

## 12. 当前结论

到当前版本为止，系统已经形成了下面的职责分离：

1. `rag_context`
   - 持续注入 RAG meta
   - 在 loop 中复用共享状态
   - 不主动注入正文

2. `rag_search`
   - 按 `state -> delta -> brief -> expand` 渐进补证据
   - 与自动注入共享同一状态

3. `debug`
   - 统一记录自动注入与显式检索
   - 便于后续对 query、cluster、命中和状态做回放

## 13. 仍未完成的方向

当前明确还没有完成的方向：

1. decomposition
2. 专门 reranker
4. assistant reasoning 原文级别的日志追踪
5. 多模态 embedding 接入当前渐进式披露系统

## 14. 对应文档

1. 当前实现说明：`specs/rag-progressive-disclosure.zh.md`
2. 总体架构：`specs/rag-enhance-architecture.zh.md`
3. 本回溯文档：`specs/rag-updates-history.zh.md`
