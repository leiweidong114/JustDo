# Multica 无桌面 CLI 与迁移

评测器注入 `OPENCLAW_CONFIG_PATH` 后，`JustDo-agent.exe` 通过
`--justdo-multica-bridge` 启动独立的 Electron 主进程运行时，无需用户先打开桌面端。
它复用同一个 EngineManager、会话存储、模型投影和带认证的 bridge 协议；没有降低鉴权要求。
每次 CLI 请求使用独立临时 relay 目录，不覆盖桌面 `multica/bridge.json`，退出时清理。
`--version` 也可独立运行。没有评测配置的其它调用仍保留原桌面 relay 行为。

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

验证：`agent-eval check-agent --agent justdo --model glm-4.5-air --prompt HI --database-verify`。
新环境端到端迁移仍需现场执行这条验证，当前机器的通过结果不代表所有平台已验证。

`npm test` 需要先把 `better-sqlite3` 编译成当前 Node.js ABI。测试脚本会在 Vitest
结束后（包括测试失败时）自动重新编译 Electron ABI，避免随后运行 `JustDo-agent.exe`
出现 `NODE_MODULE_VERSION` 不匹配和退出码 70。如果手工执行过
`npm rebuild better-sqlite3`，请运行 `npm run rebuild:electron-native` 恢复后再调用 JustDo。
