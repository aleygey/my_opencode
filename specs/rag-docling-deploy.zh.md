# RAG 文本化部署手册（Docling）

本手册记录从环境准备到文本产出的完整步骤，适合在本地或内网机器复用。

## 1. 环境准备

在 Debian/Ubuntu 上安装 Python 虚拟环境能力：

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-full curl
```

验证版本：

```bash
python3 --version
curl --version | head -n 1
```

## 2. 安装 Docling（隔离 venv）

在仓库根目录执行：

```bash
cd /home/zhang/01-my_code/09-my-opencode/opencode-worktrees/rag-enhance
bash script/rag/install-docling.sh
```

脚本行为：

1. 创建 `./.venv-docling`
2. 升级 `pip/setuptools/wheel`
3. 安装 `script/rag/requirements-docling.txt` 中的 `docling`
4. 输出 `docling --version` 作为健康检查

可选参数：

```bash
bash script/rag/install-docling.sh \
  --venv /opt/rag/.venv-docling \
  --python python3 \
  --requirements script/rag/requirements-docling.txt
```

内网离线安装（本地 wheel 仓）：

```bash
bash script/rag/install-docling.sh \
  --venv /opt/rag/.venv-docling \
  --requirements script/rag/requirements-docling.txt \
  --wheelhouse /opt/rag/docling-wheelhouse
```

## 3. 激活环境（可选）

脚本默认直接调用绝对路径，不强制激活；如需手动调试可激活：

```bash
source .venv-docling/bin/activate
docling --version
```

## 3.1 安装 Tesseract（方案 A，推荐内网）

在 Debian/Ubuntu 上执行：

```bash
bash script/rag/install-tesseract.sh
```

默认安装：

- `tesseract-ocr`
- `tesseract-ocr-eng`
- `tesseract-ocr-chi-sim`

可自定义语言包：

```bash
bash script/rag/install-tesseract.sh --langs "eng chi-sim"
```

## 4. URL 抓取 HTML 并转换为 text

单 URL：

```bash
bash script/rag/url-to-text.sh \
  --url "https://example.com"
```

开启图片 OCR（识别页面 `img` 里的文字）：

```bash
bash script/rag/url-to-text.sh \
  --url "https://example.com" \
  --ocr-images \
  --image-limit 30 \
  --image-inline marker
```

说明：当 `--ocr-images` 启用且系统存在 `tesseract` 时，脚本会默认优先使用 `tesseract`（更适合内网离线）。
且该路径会直接调用系统 `tesseract`，避免 docling 的 OSD 包装层导致的部分图片误报失败。

`--image-inline` 说明：

1. `marker`：仅保留 `[IMAGE:img-x]` 占位，OCR 文本只放 sidecar（推荐，避免污染 chunk）
2. `ocr`：将 OCR 内联到正文（老行为）
3. `none`：移除图片占位

指定 OCR 引擎/语言：

```bash
bash script/rag/url-to-text.sh \
  --url "https://example.com" \
  --ocr-images \
  --ocr-engine tesseract \
  --ocr-lang eng,chi_sim \
  --psm 6
```

代理控制（避免被错误代理拦住）：

```bash
# 强制绕过代理
bash script/rag/url-to-text.sh --url "https://example.com" --no-proxy

# 显式指定代理
bash script/rag/url-to-text.sh --url "https://example.com" --proxy "http://proxy.local:7890"
```

输出默认为：

- HTML 暂存目录：`./.rag/html/url/`
- 文本目录：`./.rag/text/url/`

带认证头示例：

```bash
bash script/rag/url-to-text.sh \
  --url "https://intranet.example.local/doc?id=123" \
  --header "Authorization: Bearer <token>" \
  --header "Cookie: session=<value>" \
  --name "intranet-doc-123" \
  --ocr-images \
  --keep-html
```

账号密码认证（Basic/Digest 场景）：

```bash
bash script/rag/url-to-text.sh \
  --url "https://intranet.example.local/doc/123" \
  --user "your_user" \
  --password "your_password" \
  --ocr-images
```

Cookie 文件认证（SSO 登录后导出的 cookie）：

```bash
bash script/rag/url-to-text.sh \
  --url "https://intranet.example.local/doc/123" \
  --cookie-file /path/to/cookies.txt \
  --ocr-images
```

LDAP/SSO 场景说明：

1. LDAP 只负责身份认证，`url-to-text.sh` 不能直接“输入 LDAP”完成网页表单登录
2. 脚本本质是 `curl` 抓取，通常需要有效 session（Cookie）或网关支持 Basic Auth
3. 你的内网若是 LDAP + SSO（CAS/OIDC/SAML），推荐先在浏览器登录，再导出 `cookies.txt` 给 `--cookie-file`

命令标准输出会打印生成的 `.txt` 路径，可直接接入后续 embedding 流程。

图片相关输出文件（`--ocr-images`）：

1. 主文本：`<name>.txt`（`<!-- image -->` 会被替换为 `[IMAGE:img-x]` + 就地 OCR）
2. 原始文本备份：`<name>.raw.txt`
3. 图片 sidecar：`<name>.images.json`（包含 `id/url/alt/ocr_text/status`）
4. OCR 运行日志：`<name>.image_ocr.log`

说明：

1. 默认只提取 HTML 可见文本，不做图片 OCR
2. `--ocr-images` 会解析页面 `<img>` 链接并逐张 OCR，并就地写回到图片占位符附近
3. 若页面是前端渲染（图片不在原始 HTML），需要先用浏览器渲染后再抓取 HTML 或导出 PDF 再转文本

### 图片 OCR 常见问题

如果你看到“图片无法识别”或 `image_ocr_total` 有值但 `success=0`，通常是 OCR 模型未就绪：

1. `docling` 的 `rapidocr/auto` 首次运行可能需要联网下载模型
2. 内网环境需预下载模型并同步缓存，或改用本机 `tesseract`

你给的日志 `wiki.luckfox.com-zh-Luckfox-Pico-Zero-Overview.image_ocr.log` 显示：

1. 模型下载是成功的（`Successfully saved`）
2. 失败原因是 `RapidOCR returned empty result`（检测不到文字）
3. 因此该问题不只是“无法访问”，更像是该页面图片内容对 RapidOCR 不友好
4. 当前切换到 tesseract 后，报错多为 `OSD failed / Too few characters`，可通过 `--psm 6` 降低此类问题

推荐排查顺序：

```bash
# 1) 查看脚本 stderr 给出的 image_ocr.log（默认在输出目录，如 ./.rag/text/url/<name>.image_ocr.log）

# 2) 若能用系统 OCR，安装 tesseract 后强制使用
sudo apt install -y tesseract-ocr tesseract-ocr-eng
bash script/rag/url-to-text.sh --url "https://example.com" --ocr-images --ocr-engine tesseract --ocr-lang eng

# 3) 若必须用 docling 默认 OCR，则在可联网机器先完成一次图片 OCR 预热，
#    再把相关缓存目录复制到内网机器（例如 ~/.cache/rapidocr、~/.cache/docling）
```

## 5. 批量目录转 text

把资料目录递归转换成文本，并保持子目录结构：

```bash
bash script/rag/convert-dir-to-text.sh \
  --input /data/rag/raw \
  --output /data/rag/text
```

默认处理扩展名：

`pdf docx pptx html htm md txt csv xls xlsx xml`

自定义扩展名：

```bash
bash script/rag/convert-dir-to-text.sh \
  --input /data/rag/raw \
  --output /data/rag/text \
  --ext "pdf docx html"
```

转换日志：

- 成功清单：`/data/rag/text/_success.log`
- 失败清单：`/data/rag/text/_failed.log`
- 运行日志：`/data/rag/text/_run.log`

## 6. 内网离线打包与安装（Ubuntu 22.04）

在可联网机器打包：

```bash
bash script/rag/build-offline-bundle.sh \
  --out /tmp/rag-offline-bundle \
  --langs "eng chi-sim" \
  --include-llamaindex \
  --include-vectordb
```

产物：

1. 目录：`/tmp/rag-offline-bundle`
2. 压缩包：`/tmp/rag-offline-bundle.tar.gz`

拷贝到内网目标机后安装：

```bash
tar -xzf rag-offline-bundle.tar.gz
bash script/rag/install-offline-bundle.sh \
  --bundle ./rag-offline-bundle \
  --venv ./.venv-docling \
  --install-llamaindex \
  --install-vectordb
```

## 7. 数据清洗与结构化

清洗文本：

```bash
./.venv-docling/bin/python script/rag/clean-text.py \
  --input .rag/text/url/<name>.txt \
  --output .rag/text/url/<name>.clean.txt
```

结构化输出（规则模式）：

```bash
./.venv-docling/bin/python script/rag/structure-text.py \
  --text .rag/text/url/<name>.clean.txt \
  --images .rag/text/url/<name>.images.json \
  --output .rag/text/url/<name>.structured.json \
  --source-url "https://example.com" \
  --mode rule \
  --inline-ocr strip
```

结构化输出（LlamaIndex）：

```bash
export OPENAI_API_KEY=...
./.venv-docling/bin/python script/rag/structure-text.py \
  --text .rag/text/url/<name>.clean.txt \
  --images .rag/text/url/<name>.images.json \
  --output .rag/text/url/<name>.structured.json \
  --source-url "https://example.com" \
  --mode llamaindex \
  --model gpt-4o-mini
```

结构化结果包含：

1. `sections`：章节级标题、摘要、正文、关联图片 metadata
2. `chunks`：可直接喂 embedding 的分块 + `image_ids` + 来源 metadata

## 8. 备用离线方式（wheelhouse 手工流程）

若内网机器不能直接访问公网，建议在可联网机器提前准备 wheel 包：

```bash
mkdir -p /tmp/docling-wheelhouse
python3 -m venv /tmp/docling-venv
/tmp/docling-venv/bin/python -m pip install -U pip
/tmp/docling-venv/bin/pip download -r script/rag/requirements-docling.txt -d /tmp/docling-wheelhouse
tar -C /tmp -czf docling-wheelhouse.tar.gz docling-wheelhouse
```

将 `docling-wheelhouse.tar.gz` 拷贝到内网机器后：

```bash
tar -xzf docling-wheelhouse.tar.gz
python3 -m venv .venv-docling
.venv-docling/bin/python -m pip install -U pip
.venv-docling/bin/pip install --no-index --find-links ./docling-wheelhouse -r script/rag/requirements-docling.txt
```

## 9. 最小验收

```bash
./.venv-docling/bin/docling --version
bash script/rag/url-to-text.sh --url "https://example.com"
```

满足以下条件即通过：

1. `docling --version` 正常返回版本信息
2. URL 转换命令输出一个 `.txt` 文件路径
3. 对应 `.txt` 文件可读取并包含页面正文

## 10. 向量库落地（Qdrant 本地持久化 + Ollama Embedding）

安装向量依赖：

```bash
bash script/rag/install-vector.sh
```

准备 Ollama embedding 模型（建议）：

```bash
ollama pull nomic-embed-text
```

设置 OpenAI 兼容环境变量（Ollama）：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export OPENAI_API_KEY="ollama"
```

构建向量索引（单文件）：

```bash
./.venv-docling/bin/python script/rag/build-vector-index.py \
  --input .rag/text/url/<name>.structured.json \
  --db-path .rag/vector/qdrant \
  --collection rag_chunks \
  --model nomic-embed-text \
  --recreate
```

构建向量索引（目录批量）：

```bash
./.venv-docling/bin/python script/rag/build-vector-index.py \
  --input-dir .rag/text/url \
  --glob "*.structured.json" \
  --db-path .rag/vector/qdrant \
  --collection rag_chunks \
  --model nomic-embed-text
```

检索验证：

```bash
./.venv-docling/bin/python script/rag/search-vector-index.py \
  --query "如何刷写镜像到 Luckfox Pico Zero" \
  --db-path .rag/vector/qdrant \
  --collection rag_chunks \
  --model nomic-embed-text \
  --top-k 5
```

向量脚本产物说明：

1. 向量库目录：`.rag/vector/qdrant`
2. 集合名：默认 `rag_chunks`
3. 每条向量 payload 包含：`node_type(text/image)`、`chunk_id`、`section_title`、`source_url`、`image_ids`、`text`

## 11. OpenCode 注入 RAG 上下文

已提供两种接入方式：

1. 自定义工具：`.opencode/tool/rag_search.ts`（手动调用）
2. 自动注入插件：`.opencode/plugins/rag_context.ts`（每轮用户消息前自动检索 top-k 注入 `<rag_context>`）

建议环境变量：

```bash
export OPENAI_BASE_URL="http://192.168.0.99:11434/v1"
export OPENAI_API_KEY="ollama"
export RAG_STRUCT_MODE="llamaindex"
export RAG_STRUCT_MODEL="gpt-4o-mini"
export RAG_EMBED_MODEL="qwen3-embedding:4b"
export RAG_COLLECTION="rag_chunks"
export RAG_TOP_K=4
export RAG_CONTEXT_HITS=2
export RAG_CONTEXT_CHARS=120
export RAG_AUTO_INJECT=1
```

关闭自动注入：

```bash
export RAG_AUTO_INJECT=0
```

可选调试（排查“是否注入成功”）：

```bash
export RAG_DEBUG_LOG=1
```

插件会写入：`.rag/log/rag_context.log`

可选覆盖（当 OpenAI 兼容地址或密钥与默认环境不同）：

```bash
export RAG_BASE_URL="http://192.168.0.99:11434/v1"
export RAG_API_KEY="ollama"
```

## 12. Agent 一键编排（Skill）

已新增技能文件：`.opencode/skills/rag-pipeline/SKILL.md`

建议通过统一入口命令执行：

初始化（首建）：

```bash
bash script/rag/cmd/rag-init.sh --source structured --scan-dir .rag/text --glob "**/*.structured.json" --embed-model qwen3-embedding:4b --collection rag_chunks
```

增量更新：

```bash
bash script/rag/cmd/rag-update.sh --source structured --scan-dir .rag/text --glob "**/*.structured.json" --embed-model qwen3-embedding:4b --collection rag_chunks
```

该流程会维护 manifest（默认 `.rag/state/manifest.json`）用于判断：

1. `changed`：内容 hash 变化，执行“先删旧 doc_key，再 upsert 新向量”
2. `removed`：文件消失，执行按 doc_key 删除
3. embedding 模型或 collection 变化，自动触发全量重建

建议只暴露这些高层选项给用户：

1. `--source`
2. `--struct-mode`/`--struct-model`
3. `--embed-model`
4. 数据来源参数（`--url`/`--url-file`/`--input-dir`/`--scan-dir`）
5. `--collection`

其余算法细节（chunk、重试、OCR 引擎细节）默认不暴露。

## 13. 迁移到其他项目

在当前仓库执行：

```bash
bash script/rag/cmd/rag-bootstrap.sh --target /path/to/target-project
```

默认会复制：

1. `script/rag/*`（安装、转换、结构化、索引、检索、init/update）
2. `.opencode/tool/rag_search.*`
3. `.opencode/plugins/rag_context.ts`
4. `.opencode/skills/rag-pipeline/SKILL.md`

目标项目里继续执行：

```bash
cd /path/to/target-project
bash script/rag/install-docling.sh
bash script/rag/install-vector.sh
bash script/rag/cmd/rag-init.sh --help
```
