# bash 子进程的 env 用白名单，不用上游的黑名单

在 `allowed_non_write_users` 场景下，模型执行的 bash 命令只能拿到白名单中的环境变量（`PATH`、`HOME`、`LANG`、`CI`、非敏感的 `GITHUB_*` 等），用户脚本需要的其他变量通过输入显式放行。上游（Claude Code）用的是内置的一百多项黑名单，但这份清单在 Claude Code 二进制内部，我们拿不到；自己维护一份同等的黑名单，又会漏掉 pi 新增的 provider，以及用户自定义的 secret（例如 `MY_DB_PASSWORD`）。

## Consequences

- 依赖非标准环境变量的用户脚本会拿不到这些变量，必须显式放行。这一项要写进迁移表。
- env 过滤要配合 bwrap 的 PID 隔离才真正有效。bwrap 不可用时，`cat /proc/$PPID/environ` 仍然能读到 pi 进程的 env；这种情况下的处理与上游一致，只做尽力而为的过滤，并在 `docs/security.md` 中写明。
- 按值脱敏复用同一份白名单：白名单以外、长度不少于 16 的值都视为密钥。为减少误伤，再排除两类值：action 从自己的非凭据类输入设置的变量（`ACTION_SETTINGS_ENV`，如 `PROMPT`、`MODEL`），以及已存在的绝对路径或路径列表（如 `RUNNER_TEMP`、`JAVA_HOME`）。凭据类输入（`API_KEY`、`OVERRIDE_GITHUB_TOKEN`、`SSH_SIGNING_KEY`）、自由格式的透传参数（`PI_ARGS`）、`ALL_INPUTS`，以及从 workflow env 复制过来的变量仍视为密钥。按值脱敏只匹配完整的值，写进 `prompt` 的 secret 本来就只有在它自己也是一个 env 变量时才能识别。
- 会话导出（`export_session`）另加一条只用于导出的规则：变量名含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`AUTH` 等词的变量，值不少于 6 个字符也按值脱敏（`src/runner/secret-values.ts`）。导出包含每个工具结果，短 key 被命令输出后会原样进入文件；评论和报告不用这条规则，免得短值误伤普通输出。
- `GH_TOKEN` 不在白名单中，bash 中的 `git push` 和 `gh` 拿不到 token；需要时由用户在 `allowed_bash_env` 中放行，代价是 agent 也能拿到它。
- 文件工具在 pi 进程内执行，不受 env 过滤和 bwrap 约束；隔离时由工具权限扩展拒绝 `/proc` 下的路径。
