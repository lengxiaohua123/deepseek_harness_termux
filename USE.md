# DeepSeek Harness 使用教程

本文件是仓库的快速上手与本地使用备忘,命令均以仓库根目录为工作目录、以实际验证为准。权威细节请以 [docs/architecture.md](docs/architecture.md)、[docs/development.md](docs/development.md)、[docs/testing.md](docs/testing.md) 为准。

## 分支策略

- `master`:仅同步上游(`git fetch && git reset --hard origin/master`),不放任何本地改动。
- `adapt/android-termux`:本机 Android 适配的全部内容(文档、skill、session 修复、依赖与 patch),日常在此分支工作与运行。
- `feat/android-native-deps`:仅依赖与 patch(已并入 `adapt/android-termux`,保留为独立依赖集)。

## 远程与上游同步 CI

- 本仓库 GitHub 远程:`https://github.com/lengxiaohua123/deepseek_harness_termux`;上游为 `deepseek-ai/deepseek-harness`。
- CI(`.github/workflows/sync-upstream.yml`):定时把上游 `master` 镜像到本仓库 `master`(force),并重推所有分支。手动触发:`workflow_dispatch`。
- 首次使用:
  1. 本地推送全部分支:`git push origin --all`(origin 需指向本仓库)。
  2. 在 GitHub 仓库设置中把**默认分支设为 `adapt/android-termux`**——`schedule` 只从默认分支读取 workflow,而 master 会被镜像覆盖,不设默认分支则定时同步失效(手动触发仍可用)。
  3. 手动运行一次 CI(`Actions` 页 → `sync-upstream` → Run workflow)。

项目是插件化 agent harness(基于 vendored Cordis):`pnpm dsh` 是产品启动器(入口 `apps/cli/src/bin.ts`)。

## 环境与安装

要求:`node ^22.19 || >=24`、`pnpm 11.x`(项目用 `pnpm@11.7.0`,见 `package.json` 的 `packageManager`)。

```sh
npm install -g pnpm@11.7.0        # 本机未预装 pnpm 时
pnpm install --ignore-scripts     # Android/Termux 必须加 --ignore-scripts,原因见下
```

⚠️ Android/Termux 上直接 `pnpm install` 会因 `koffi@3.1.1` 原生编译失败(`statx` 与 bionic 头文件签名不兼容)而中止。安装分两步:

```sh
pnpm install --ignore-scripts
bash scripts/android-native-build.sh   # 编译 koffi/node-pty(需要 Termux 工具链:cc/make/python)
```

适配说明(仓库已固化,无需手工改):

- `koffi`:仓库内置 `patches/koffi@3.1.1.patch`(`pnpm-workspace.yaml` 的 `patchedDependencies`),在 bionic 下用 `syscall(SYS_statx, ...)` 替代直接调用;脚本编译。
- `node-pty`:脚本用本地 node 头(`--nodedir=$PREFIX`)+ npm 内置 node-gyp 编译(官方下载头会因 android NDK 分支失败)。
- `sharp`:`@img/sharp-wasm32` 已加入根 devDependencies,sharp 在 android 平台自动走 wasm32 兜底,无需 libvips。
- `esbuild`/`rolldown` 为预编译平台包,不受影响。

构建、测试、门禁、`dsh` 源码运行均可用;web 的原生能力(PTY 终端、sandbox、附件图片处理)在编译后同样可用。

## 构建

```sh
pnpm run build          # tsc 产出 lib/ + tsdown 打包 + web 前端
pnpm run build:lib      # 仅 lib 部分
```

`dsh` 源码运行不需要先构建;生产运行需要先 `pnpm run build`。

## 测试与门禁

```sh
pnpm run test                    # vitest 单测
pnpm exec vitest run packages/util/timeout   # 快速冒烟
pnpm run test:coverage           # CI 覆盖门禁:packages/*/*/src 每文件 100%
pnpm run test:e2e                # 真实 API 测试;无 DEEPSEEK_API_KEY 时自动跳过
pnpm run test:snapshot           # 无 key 的 ACP/headless 回放快照;-t <name> 过滤
pnpm run typecheck && pnpm run lint
pnpm run verify-doc-budgets && pnpm run verify-md-wrap   # 文档预算/排版门禁
pnpm run doc-sync                # 全部文档门禁
pnpm run check:all               # 全部门禁入口(scripts/run-gates.ts)
```

## 运行 agent 任务(`dsh` CLI)

```sh
pnpm dsh --help                                  # 启动器帮助
pnpm dsh --profile headless "run the tests"      # 跑一个任务,打印最终回答后退出
pnpm dsh --profile headless --dump-config        # 不启动,查看组合后的配置树
pnpm dsh web                                     # 等价于 --profile web;注意:web 需 --expose-internals,见下
pnpm dsh plugin --profile <name> <pnpm args>     # 管理某 profile 的插件
```

- API key:真实任务需要 `DEEPSEEK_API_KEY`(环境变量或根 `.env`,可选 `DEEPSEEK_BASE_URL`)。
- profiles:`web`、`headless` 首次使用从自带模板自动初始化于 `$DSH_HOME/profiles/<name>`;其他 profile 用 `dsh plugin` 创建。内置 agent-preset 模板在 `apps/cli/config/agent-presets/`(`code`/`cordis`/`minimal`/`standard`)。
- 参数规则:启动器 flag 在前;第一个不被启动器识别的 token 起归 app(如 `pnpm dsh --profile web --port 8080` 中 `--port` 属于 web app)。

### Android/Termux 上运行 web UI

`cordis-plugin-hmr` 运行需要 `--expose-internals`,因此不用 `pnpm dsh` 包装而直接调 `node`;无需任何 patch,原生能力全部可用:

```sh
pnpm run build   # 必需:web 需要 lib/ 产物与前端 dist/
node --expose-internals --import tsx/esm apps/cli/src/bin.ts web --port 0
```

- 原生能力:koffi/node-pty 编译后可加载,sharp 走 `@img/sharp-wasm32` 兜底;PTY 终端、附件图片处理均可用。
- 目录选择:Android 上 `directory-picker` 自动回落 `browse` 后端(纯 Node stdlib 的目录列举/创建,浏览器端交互;`tsconfig.base.json` 已补其 client 包映射,源码运行可解析)。
- 平台边界:进程隔离 sandbox 依赖 Landlock(Android 内核未启用,实测 `ENOSYS`)或 bwrap(未安装),调用时按设计 fail-closed 显式报错,不会静默降级。
- 启动日志打印监听地址(如 `dsh web: http://127.0.0.1:<port>`),用 `curl http://127.0.0.1:<port>/` 验证(应返回 200 与 HTML)。

## 目录速览

```
apps/cli/      dsh 启动器入口(src/bin.ts;命令语法见 src/args.ts)
packages/      全部 @deepseek-ai/dsh-* 插件包;权威分组表见 packages/README.md
examples/      可运行的 cordis.yml 叶子(见 examples/AGENTS.md)
docs/          架构/测试/防御模式等(见 docs/AGENTS.md)
vendor/        vendored Cordis 源码(更新流程见 vendor/README.md)
```

## 常见问题

| 现象 | 处理 |
|---|---|
| `pnpm install` 报 `koffi ... invalid conversion` | Android 环境,改用 `pnpm install --ignore-scripts` |
| 安装时 WARN `Failed to create bin ... lib/bin.js` | `lib/` 未构建,`pnpm run build` 后恢复 |
| `pnpm dsh --profile headless "任务"` 报 key 错 | 未配置 `DEEPSEEK_API_KEY`;e2e 测试同样自跳过 |
| 想验证环境可用 | `pnpm dsh --version`、`pnpm exec vitest run packages/util/timeout`、`pnpm run build:lib:host` |
