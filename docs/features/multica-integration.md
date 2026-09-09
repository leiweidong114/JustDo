# Multica integration

JustDo prepares a generated user-local `<productName>-agent` launcher for a Multica custom runtime.
The launcher connects Multica to the running desktop process, so no separately installed agent CLI
is required. The desktop process owns configuration and credentials while the bundled Agent runtime
executes each task in Multica's isolated working directory.

The integration is local-only. It does not call Multica server APIs and does not start, stop, or
restart the Multica daemon. The only Multica CLI commands JustDo may execute are `--version` and
`daemon status ... --output json`; the latter reads the daemon's loopback health endpoint.

## Lifecycle

1. Keep JustDo running or in the tray and enable the integration from Settings → External connections
   → Accept external connections.
2. JustDo detects the desktop-launched Multica profile when available and creates the launcher
   without modifying any Multica profile config or credentials. Launcher creation does not require
   the Multica daemon to be running.
3. On Windows, Multica must call a native executable directly. Batch and PowerShell wrappers are not
   compatible: batch has an 8,191-character command-line limit, while Multica's environment
   preparation calls `binary_path config file` without a custom profile's fixed arguments. Windows
   therefore uses a small native `<productName>-agent.exe` beside the app executable. It removes the
   `ELECTRON_RUN_AS_NODE` variable inherited from Multica Desktop and forwards the original argv and
   output streams to `<productName>.exe`. Development builds a native launcher under
   `%APPDATA%/<productName>/multica/development` with `npm run multica:dev-agent`; it starts the
   current worktree's Electron executable and application bundle directly, without requiring a
   packaged/unpacked app. Release packaging creates the adjacent production launcher automatically.
   Settings renders Windows command paths with forward slashes because Multica's command-line form
   treats backslashes as escape characters.
   On macOS/Linux, the product-named executable script is installed into a writable user-owned
   directory on `PATH`.
4. Settings shows the exact base protocol, display name, command, and description to enter in
   Multica's **Create custom runtime** dialog. Each value has a copy action.
5. The user creates the workspace-scoped profile from Multica. JustDo neither submits that form nor
   verifies it through the Multica server. Disabling removes only the owned local launcher.

The manual profile uses `productName` as its display name. Its command is the exact value shown in
Settings; Windows uses the native `<productName>-agent.exe` bootstrapper, while macOS/Linux use
`<productName>-agent` directly.
Creating it remains a Multica-owned operation: v0.4.32 stores custom runtime profiles on the server
and synchronizes them across the workspace. Existing server-side profiles remain usable, but this
integration neither reads nor mutates them.

Multica's OpenClaw-compatible model picker enumerates Agent IDs. The bridge projects enabled JustDo
Agents into both supported discovery responses and omits the managed scheduler. An `agent` request
therefore selects that exact JustDo Agent; its model, system prompt, identity and managed skills all
remain intact, while provider credentials and runtime configuration stay in the desktop process.

Multica v0.4.36's local `runtime profile set-path` escape hatch is not usable for a normal Windows
`.exe`: its daemon checks Unix executable permission bits (`0o111`), which Windows `os.Stat` does not
set for ordinary executable files. The integration therefore shows a native absolute command for
the custom runtime instead of relying on that local override.

### Development workflow

Run `npm run multica:dev-agent` after changing the native launcher, then run
`npm run electron:dev:openclaw` to compile the bridge client and keep that JustDo process open. The status card shows the native
development Agent executable to enter as Multica's command. The launcher writes redacted lifecycle
diagnostics to `%APPDATA%/<productName>/multica/agent-launcher.log`; it records only command class,
argument count, PID, and exit code. Server-side bridge changes take effect when the Electron
development process restarts. Packaged/unpacked validation remains required before release because
runtime resource paths differ from development.

Multica v0.4.36 may omit `launched_by` from `daemon status --output json`. JustDo still limits
detection to Desktop-owned profiles: it accepts the explicit `launched_by: desktop` signal, or the
Desktop profile naming convention together with Multica Desktop's `.desktop-user-id` sidecar.

## Security and sessions

- The launcher accepts only the compatibility command shapes used by Multica.
- A per-process random token protects the local named pipe/Unix socket. Tokens and profile credentials
  are never sent to the renderer or written to logs.
- The evaluator's temporary OpenClaw config is not used for an Agent turn. JustDo synchronizes its
  own Agent/provider/system-prompt configuration before sending the turn through Cowork/Gateway.
  When the requested model is absent from JustDo, the authenticated local bridge temporarily
  imports the evaluator's OpenAI-compatible LiteLLM endpoint and run-scoped credential, then
  removes that provider after the visible Cowork run. It never changes the main Agent's permanent
  model binding.
- Multica tasks use local mode, so the task workspace remains the Multica worktree. Staged
  `skills/<skill>/SKILL.md` directories are discovered there and recorded on the visible turn.
- Each external session maps to one managed Cowork session key. User, assistant, thinking and tool
  events stream into the normal JustDo chat window with a Multica badge; the session remains
  read-only because the evaluator owns turn submission and cancellation.

## Direct Skill-Up evaluation

`agent_eval_multca_skillup` imports Multica v0.4.36's open-source Agent backend directly and does
not run Multica Server or a Multica daemon. This mode uses the same launcher and local bridge. Keep
JustDo running or in the tray, enable external connections once, and pass the launcher as the
evaluator's `--agent-executable`.

Use the evaluator's user-facing `--agent justdo` entry. It reuses Multica's OpenClaw-compatible
backend internally, but that implementation detail does not belong in the command line. For JustDo,
the evaluator's `--model` retains its normal meaning: it is the provider model ID to evaluate. The
model is resolved from an enabled JustDo provider first. If it is absent there, the bridge uses the
evaluator's OpenAI-compatible LiteLLM profile as a temporary request-scoped provider. Use a
provider-qualified reference such as `litellm/glm-4.5-air` when the same configured model ID exists
under multiple providers. The bridge applies it as a session-only model override before the first
turn and fails closed if Gateway rejects the selection. The main Agent's permanent model
configuration is not changed. The backend emits
`agent --local --json --session-id ... --timeout ... --agent main --message ...`; the bridge sends
that turn through the same Cowork router and Gateway path as the JustDo chat composer.

### JustDo 调用命令

保持 JustDo 桌面端运行，然后在包含评测 `skills/` 目录的工作区执行：

```powershell
$justDoAgent = "$env:APPDATA\JustDo\multica\development\JustDo-agent.exe"

# 查看 Multica 可以选择的 JustDo Agent ID。
& $justDoAgent agents list --json

# 直接向 JustDo 的 main Agent 发起一个可见 Cowork 对话。
$env:AGENT_EVAL_PROVIDER_MODEL = 'glm-4.5-air'
& $justDoAgent agent --local --json `
  --session-id "multica-manual-$([guid]::NewGuid().ToString('N'))" `
  --timeout 180 `
  --agent main `
  --message "请使用当前工作区里的评测 skill 完成任务"
Remove-Item Env:AGENT_EVAL_PROVIDER_MODEL
```

这里的 `--agent main` 是兼容协议内部使用的 JustDo 主 Agent ID，不是模型名。评测 CLI 的
`--model glm-4.5-air` 通过 `AGENT_EVAL_PROVIDER_MODEL` 传入，并只覆盖本次外部会话的模型。
手工调用 launcher 时仍需先在 JustDo 中启用模型，因为该命令没有评测器的 LiteLLM provider
参数；通过 `agent-eval` 调用时，未配置模型会自动使用评测器的临时 provider。模型 ID 跨
已配置 provider 重名时传入 `provider/model`。
运行后，任务出现在 JustDo 会话列表的 `[Multica] ...` 条目中；打开该条目即可实时查看消息、
thinking 和工具调用过程。

Windows development build:

```powershell
npm run multica:dev-agent
npm run electron:dev:openclaw

Set-Location D:\AI_FOR_WORLD\14_AI_workspace\common_tools\agent_eval_multca_skillup
.\backend\.runtime\windows\python\Scripts\agent-eval.exe run `
  --skill .\backend\skills\example-marker `
  --agent justdo `
  --model glm-4.5-air `
  --case .\backend\skills\example-marker\evals\cases\marker.yaml `
  --parallelism 1 `
  --iterations 1 `
  --benchmark
```

Windows automatically discovers `%APPDATA%\JustDo\multica\development\JustDo-agent.exe`. Only add
`--agent-executable <path>` when using a non-default launcher location; alternatively set
`JUSTDO_AGENT_EXECUTABLE` once in the environment.

Linux development build:

```sh
npm run electron:dev:openclaw
# Enable external connections in JustDo once; the UI creates ~/.local/bin/JustDo-agent.

cd /path/to/agent_eval_multca_skillup
./backend/.runtime/linux/python/bin/agent-eval run \
  --skill ./backend/skills/example-marker \
  --agent justdo \
  --model glm-4.5-air \
  --case ./backend/skills/example-marker/evals/cases/marker.yaml \
  --parallelism 1 \
  --iterations 1 \
  --benchmark
```

Start cross-platform validation with `--parallelism 1`. Increase it only after verifying that two
simultaneous cases receive distinct external session IDs, Cowork sessions, and working directories.
