# 与上游的偏离

本仓库在 workflow 能看到的行为上尽量与 [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)（下称"上游"）保持一致。代码独立维护，不再从上游 cherry-pick。下面登记每一项行为偏离和原因。

## 规则

- 只有 4 类原因允许偏离：

  | 类别             | 含义                                   |
  | ---------------- | -------------------------------------- |
  | `pi-capability`  | pi 没有某项能力，或者做法不同          |
  | `multi-provider` | 支持多个模型 provider 带来的差异       |
  | `branding`       | 本项目不是官方产品，不使用 Claude 品牌 |
  | `scope`          | 本项目明确不做                         |

- 改变行为的 PR 要在同一个 PR 中更新本文；用户可见的偏离还要写进 README 的迁移对照表。没有登记的偏离视为缺陷。
- 难以撤回的偏离另写 ADR，在条目中注明。
- 每项偏离占表格一行，写清差在哪、指向实现文件；理由不显然时，在表格下补充说明。实现细节写在代码里，不在这里复述。

## 执行引擎与输入

| 偏离                     | 上游 → 本仓库                                                                                                                                                                                                                                                     | 类别             | 用户可见 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| 执行引擎                 | Claude Code（Agent SDK）→ pi SDK，在 action 进程内运行（`src/runner/`，ADR-0001）                                                                                                                                                                                 | `pi-capability`  | 否       |
| 模型与认证               | `anthropic_api_key`、OAuth token、`use_bedrock` 等 → 必填的 `model`（`provider/id`），key 按 pi 的变量名经 `env:` 传入，或用 `api_key`                                                                                                                            | `multi-provider` | 是       |
| OpenAI 兼容端点          | 无 OpenAI provider → workflow 的 `OPENAI_BASE_URL` 覆盖 `openai` 的端点，主 Runner、compaction 和独立评论分类共用；只保留 pi 静态模型目录，不读 `models.json`、不做 OAuth 登录、不在失败时回退官方端点（`src/runner/model-runtime.ts`、`src/runner/run-plan.ts`） | `multi-provider` | 是       |
| 透传参数                 | `claude_args` → `pi_args`，只接受部分 pi 参数，其余报错（`src/runner/pi-args.ts`）                                                                                                                                                                                | `pi-capability`  | 是       |
| 删除的输入               | 见下表；设置了就在 prepare 阶段失败，并指向迁移对照表（`src/entrypoints/removed-inputs.ts`）                                                                                                                                                                      | 见下表           | 是       |
| 仓库的设置文件           | 读取 `.claude/settings.json` → 不读 `.pi/settings.json`，设置只在内存中（`src/runner/run-pi.ts`）                                                                                                                                                                 | `pi-capability`  | 是       |
| Claude Code 专用环境变量 | `ANTHROPIC_*`、`CLAUDE_CODE_*`（含 `SCRIPT_CAPS`、`SUBPROCESS_ENV_SCRUB`）、`OTEL_*` 生效 → 不读                                                                                                                                                                  | `pi-capability`  | 是       |
| skills 输入              | 无 → 新增 `skills`：prepare 阶段用 `gh skill install` 装到 checkout 之外的目录，pi 以 `--skill` 路径的方式加载，不受 `--no-skills` 影响（`src/runner/skills.ts`）                                                                                                 | `pi-capability`  | 是       |
| inline comment 分类      | Claude Haiku，用 `anthropic_api_key` → 经 pi 用 `model` 分类，或用新增的 `classify_model`；失败时全部发布（`src/runner/classify-comments.ts`）                                                                                                                    | `multi-provider` | 是       |
| 触发词、标签、分支前缀   | `@claude` / `claude` / `claude/` → `@pi` / `pi` / `pi/`                                                                                                                                                                                                           | `branding`       | 是       |
| GitHub App 与 token 换取 | Anthropic 的服务和 `claude[bot]` → 本项目的服务（`services/token-exchange/`）和 `pi-agent-action[bot]`；接口和错误码不变（`src/github/token.ts`，ADR-0003）                                                                                                       | `branding`       | 是       |

删除的输入：

| 输入                                                                                                                        | 类别             | 原因                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `anthropic_api_key`、`claude_code_oauth_token`、workload identity 的 5 个输入、`use_bedrock` / `use_vertex` / `use_foundry` | `multi-provider` | 由 `model` 加 `env:` 取代                                            |
| `claude_args`                                                                                                               | `pi-capability`  | 由 `pi_args` 和独立输入取代                                          |
| `settings`                                                                                                                  | `pi-capability`  | 格式不兼容；pi 的部分设置（`shellPath`、`packages`）能绕开安全默认值 |
| `plugins`、`plugin_marketplaces`                                                                                            | `pi-capability`  | pi 没有 Claude Code 的插件市场；其他仓库的 skill 用 `skills` 安装    |
| `include_fix_links`                                                                                                         | `branding`       | 链接打开的是 Claude Code 网页版，pi 没有对应                         |
| `path_to_claude_code_executable`                                                                                            | `pi-capability`  | pi 在进程内运行，版本由 action 锁定，没有可替换的可执行文件          |

- 删除的输入仍以占位形式声明在 `action.yml` 中：composite action 读不到未声明的输入，GitHub 只给一条警告，静默忽略会让 workflow 以为配置生效了。
- `model`、`allowed_tools` 曾是上游 v0.x 的输入，v1.0 并入了 `claude_args`。本仓库恢复成独立输入：没有默认 provider，`model` 必须显式给出；工具规则由 action 执行，而不是 pi，放进 `pi_args` 会混入 pi 不认识的参数。
- 分类默认用 `model`，不自动选 jev 这类分类模型：只有部分 provider 提供，而且 key 能否调用取决于套餐，自动选择会让分类时好时坏。

## 工具与权限

| 偏离                | 上游 → 本仓库                                                                                                                                                                                                                | 类别            | 用户可见 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| 未命中规则的调用    | `--permission-mode auto` 交给安全审查 → 直接拒绝；只读工具（Read、Grep、Glob、LS）总是放行（`src/runner/tool-permissions.ts`）                                                                                               | `pi-capability` | 是       |
| 组合命令            | 拆开后逐段匹配，另有内置只读命令 → 有 `Bash(...)` 规则参与判断时，拒绝 `&&`、`;`、`\|`、`$()`、重定向等；只读命令只剩 tag mode 的只读 git 命令（`src/runner/shell-syntax.ts`、`read-only-git.ts`）                           | `pi-capability` | 是       |
| 规则语法            | Read、Edit 可带路径，WebFetch 可带 `domain:` → 只有 Bash 规则可带 pattern，其他工具带 pattern 时运行失败；pi 没有的工具只打印警告（`src/runner/tool-rules.ts`）                                                              | `pi-capability` | 是       |
| codemode            | 无 → `pi_args: --tools +codemode` 开启 pi 的 `codemode` 工具（与 pi 一样默认关闭）：模型可以写 JS 脚本调用其他工具和 classifier 等非对话模型；它本身不需要规则，脚本里的每次工具调用照常按规则检查（`src/runner/run-pi.ts`） | `pi-capability` | 是       |
| tag mode 的文件编辑 | acceptEdits 模式 → 扩展放行工作目录内的 `edit`、`write`，`.git/` 除外（`src/runner/workspace-path.ts`）                                                                                                                      | `pi-capability` | 否       |

- codemode 不扩大权限：脚本在没有文件系统和网络的 QuickJS 沙箱里运行，只能通过工具和 `models` 影响外部，而工具调用经过同一个 `tool_call` hook（`test/pi-sdk/codemode.test.ts`）。`models` 的调用（分类、生成图片）不是工具调用，规则管不到，费用记在 provider key 上。
- 不拆分组合命令：拆分要完整实现 bash 语法，漏掉一种写法就能绕过规则；直接拒绝容易验证，模型收到原因后会逐条执行。
- 不放行 `.git/` 下的写入：写进去的 hook 会在 `git commit` 时执行任意命令，绕过 bash 规则。
- 只读 git 命令带 `--output`、`--ext-diff`、`--textconv`、`-c`、`-C` 等选项时不放行，因为这些选项能写文件或执行程序。

## MCP 与提示词

| 偏离             | 上游 → 本仓库                                                                                                                                                                                                                         | 类别            | 用户可见 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| MCP server 注册  | `--mcp-config`，并读取用户和项目的 MCP 配置 → 通过 SDK 以 `direct` 模式注册，不读任何 `mcp.json`；用户暂时不能添加自己的 server（`src/runner/mcp-servers.ts`，ADR-0001）                                                              | `pi-capability` | 是       |
| 评论工具名       | `update_claude_comment` → `update_comment`                                                                                                                                                                                            | `branding`      | 是       |
| tag mode 提示词  | 让模型先用 ToolSearch 加载工具 → 不提 ToolSearch                                                                                                                                                                                      | `pi-capability` | 否       |
| 评论中的斜杠命令 | `@claude /cmd` 作为单独的消息块交给 Claude Code，展开 `.claude/commands/cmd.md` → Runner 自己展开 `/skill:<name>` 和 `/<模板>`（`.pi/skills/`、`.agents/skills/`、`.pi/prompts/`），追加在提示词末尾（`src/runner/slash-command.ts`） | `pi-capability` | 是       |

- 不读仓库的 `.pi/mcp.json`：pi 中配置文件里的同名 server 优先于 SDK 注册的 server，被检出的代码可以借此换掉本项目的 server，拿到 GitHub token。server 的 `env` 值一律转义，因为 pi 会展开 `$NAME`、执行以 `!` 开头的值，而分支名等值来自仓库。
- 用 `direct` 模式：pi 默认的 `codemode` 不直接向模型声明工具，和提示词中"调用某工具"的指令对不上。pi 没有 ToolSearch，工具直接声明，所以提示词不提它。
- 斜杠命令由 Runner 展开：pi 只展开以 `/` 开头的消息，而 tag mode 的提示词以 GitHub 上下文开头。展开格式与 pi 自己的一致，`test/pi-sdk/slash-command.test.ts` 用真实的 pi 会话核对；上游的 `.claude/commands/` 要搬到 `.pi/prompts/`。

## 隔离与脱敏

前四项只在设置了 `allowed_non_write_users` 时生效。

| 偏离               | 上游 → 本仓库                                                                                                                                                                                                     | 类别             | 用户可见 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| bash 的 env        | Claude Code 内置的黑名单 → 白名单（`src/runner/env-allowlist.ts`），`allowed_bash_env` 放行更多，`subprocess_isolation: false` 关闭（ADR-0002）                                                                   | `pi-capability`  | 是       |
| bash 沙箱          | Claude Code 内置 → bwrap 可用时：新的 PID namespace 和 `/proc`、`no_new_privs`，只有工作目录和空的 `/tmp` 可写；不可用时只过滤 env 并警告（`src/runner/bash-isolation.ts`）                                       | `pi-capability`  | 是       |
| 文件工具与 `/proc` | 无 → 文件工具拒绝访问 `/proc`（`src/runner/tool-permissions.ts`，ADR-0002）                                                                                                                                       | `pi-capability`  | 否       |
| PR 场景的配置恢复  | `SENSITIVE_PATHS` 只有 Claude 的路径 → 补上 `.pi`、`.agents`、`AGENTS.md`、`AGENTS.MD`、`AGENTS.override.md`、`CLAUDE.MD`（`src/github/operations/restore-config.ts`）                                            | `pi-capability`  | 否       |
| 输出脱敏           | 按格式匹配 GitHub、Anthropic、AWS、Slack、JWT → 加上 OpenAI、OpenRouter、Gemini 的格式，以及按值匹配长度不少于 16 的非白名单 env 值（`src/runner/secret-values.ts`、`src/runner/comment-redaction.ts`，ADR-0002） | `multi-provider` | 是       |

- 用白名单而不是黑名单：上游的黑名单在 Claude Code 内部，拿不到；provider 太多，黑名单也列不全。`GH_TOKEN` 同样被去掉，所以 bash 中的 `git push` 和 `gh` 要显式放行它。
- 文件工具在 pi 进程内执行，不经过 bwrap，能直接读 `/proc/self/environ`，所以要单独拦截。检查和执行之间被并行的 bash 换掉符号链接的竞争无法排除。
- 按值脱敏：OpenCode 等 key 格式未知的 provider 只能按值识别；代价是 workflow 自己设置的长 env 值（URL 等）也会被替换。
- pi 的上下文文件接受大写的 `.MD`，在区分大小写的 runner 上是不同的文件，所以要单独列出。

## 输出与报告

| 偏离               | 上游 → 本仓库                                                                                                                                              | 类别                        | 用户可见 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------- |
| 跟踪评论与提示词   | `Claude Code is working…`、`**Claude finished …**`、`You are Claude`、指向上游的 FAQ、提交信息 `from Claude` → pi 的文字，提示词不指名模型，FAQ 指向本仓库 | `branding`                  | 是       |
| 跟踪评论的 spinner | Claude 标志的动画（GitHub user-attachments 上的图片）→ 本仓库的 `assets/spinner.gif`（`src/github/operations/comments/common.ts`）                         | `branding`                  | 是       |
| "Create a PR" 链接 | 标题 `Changes from Claude`，正文带 Claude Code 签名 → `Changes from pi`，不带签名（`src/entrypoints/update-comment-link.ts`）                              | `branding`                  | 是       |
| 结构化输出         | `claude_args` 中的 `--json-schema` → `json_schema` 输入，模型调用 `submit_result` 提交，最多提醒 2 次（`src/runner/structured-output.ts`）                 | `pi-capability`             | 是       |
| Execution file     | Agent SDK 的消息 → pi 的会话头和事件，最后一条 `session_stats` 是合计（`src/runner/execution-file.ts`，ADR-0001）                                          | `pi-capability`             | 是       |
| step summary       | `Claude Code Report`，解析 SDK 消息 → `pi Agent Report`，解析 pi 事件（`src/entrypoints/format-turns.ts`）                                                 | `pi-capability`、`branding` | 是       |
| `show_full_output` | 原样打印 SDK 消息 → 打印 pi 事件，先脱敏                                                                                                                   | `pi-capability`             | 是       |
| `session_id`       | 可以用 `--resume` 继续 → 会话只在内存中，不能继续（ADR-0001）                                                                                              | `pi-capability`             | 是       |

## 仓库与 CI

| 偏离                   | 上游 → 本仓库                                                                                                                                                                                                          | 类别            | 用户可见 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| 源码标识符与临时文件名 | `claudeBranch` → `agentBranch`、`claudeCommentId` → `trackingCommentId`、`updateClaudeComment()` → `updateComment()`、`CLAUDE_*` 环境变量 → `AGENT_BRANCH` 等、`claude-*` 临时文件 → `pi-*`、`.claude-pr/` → `.pi-pr/` | `branding`      | 否       |
| `base-action/`         | 独立目录，镜像到另一个仓库并发布 npm 包 → 删除，执行器在 `src/runner/`                                                                                                                                                 | `scope`         | 否       |
| `agent-approval-check` | 自带这个子 action → 删除；需要的 workflow 继续引用上游的                                                                                                                                                               | `scope`         | 是       |
| 自建 App 的创建工具    | `github-app-manifest.json` 和 `docs/create-app.html` → 删除，`docs/setup.md` 用文字说明                                                                                                                                | `scope`         | 否       |
| workflow 加固检查      | 检查 `--permission-mode auto` → 检查 `allowed_tools` 中的 `*` 只用于 `mcp__` 工具（`.github/scripts/check_workflow_hardening.py`）                                                                                     | `pi-capability` | 否       |

- `CLAUDE.md`、`.claude/` 等 pi 也会读取的配置路径不改名。
