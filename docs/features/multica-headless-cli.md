# Multica 无桌面 CLI 与迁移

`JustDo-agent.exe` 优先连接已经运行的 JustDo 桌面 relay，即使评测器注入了
`OPENCLAW_CONFIG_PATH`；这样 Agent turn 会实时显示在聊天窗口。没有桌面 relay 时，launcher
通过 `--justdo-multica-bridge` 启动短生命周期 Electron 主进程，复用 JustDo 自己的
EngineManager、Cowork router、会话数据库和带认证 bridge 协议。独立进程不使用评测器的
OpenClaw 配置覆盖 JustDo Agent，只在请求结束后停止它启动的 Gateway。会话和完整消息仍会
持久化，下次打开 JustDo 时可见。

桥接以 Cowork 会话终态为准：如果 OpenClaw 在工具调用之间因模型额度、鉴权或上游错误
进入 `error`，即使此前已经生成过部分 assistant 文本，也会向 Multica 返回失败，而不会把
部分文本误报为一次成功完成。

## 在新 Windows 环境从源码构建

```powershell
cd "新路径\JustDo"
npm ci
npm run openclaw:runtime:host
npm run multica:build-agent
```

需要 Node 24（以 package.json engines 为准）、.NET Framework C# 编译器及 Electron 原生依赖。
构建生成 `%APPDATA%\JustDo\multica\development\JustDo-agent.exe`。
评测器可自动发现该默认位置，或用 `--agent-executable` 指定它。
移动源码后务必重新运行 `multica:build-agent`，开发 launcher 中的路径才会重新生成。
不要只移动这个小 exe：它依赖源码目录下的 `dist-electron`、Electron、OpenClaw runtime 及原生模块。

内网离线构建需要预先准备 npm 缓存、Electron 下载缓存和目标平台 OpenClaw runtime；
仅复制源码不能在完全无依赖的新机器上离线构建。或者在有网构建机生成完整安装包，移动整个产物。
LiteLLM 地址、密钥、数据库网络连通性必须在新环境重新配置，不把旧凭据编入程序。

验证：`agent-eval check-agent --agent justdo --model main --prompt HI --database-verify`。
新环境端到端迁移仍需现场执行这条验证，当前机器的通过结果不代表所有平台已验证。

`npm test` 需要先把 `better-sqlite3` 编译成当前 Node.js ABI。测试脚本会在 Vitest
结束后（包括测试失败时）自动重新编译 Electron ABI，避免随后运行 `JustDo-agent.exe`
出现 `NODE_MODULE_VERSION` 不匹配和退出码 70。如果手工执行过
`npm rebuild better-sqlite3`，请运行 `npm run rebuild:electron-native` 恢复后再调用 JustDo。
