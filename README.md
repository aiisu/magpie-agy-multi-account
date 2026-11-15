# Magpie agy CLI 多账号插件

基于 `@magpie-community/opencode-agy-cli-auth` 0.1.55 的独立 fork。
保留原来的 ACP、工具调用和模型目录实现，为每个账号增加独立的 CLI 环境。
Provider ID 仍为 `agy-cli`，现有模型分组可以继续引用它。

## 运行要求

- Linux、Bun、`/usr/bin/flock` 和已安装的官方 agy CLI。
- Magpie 支持多账号插件及 `{ id, server }` 插件入口。
- 使用 Linux 文件凭据存储；不支持 macOS/Windows 系统钥匙串的多账号隔离。
- `XDG_CONFIG_HOME/magpie/plugin-auth.json` 是 Magpie 的实际账号文件。
- 账号数据和临时目录应在持久化、允许执行的文件系统上。

## 安装和更新

将仓库下载到独立的持久化目录，检出经过测试的完整 commit SHA，再安装：

```sh
git clone https://github.com/aiisu/magpie-agy-multi-account.git
cd magpie-agy-multi-account
git checkout <tested-full-commit-sha>
bun test tests
magpie plugin add "$(pwd)"
```

同一个 `agy-cli` provider 只注册此 fork 或上游其中一个。已有上游注册时，
先备份 Magpie 配置，并将该插件条目的 `spec` 改为此目录，其他条目保持原样。
修改注册后重启 Magpie。

插件源码不放在 Magpie 自动安装依赖的 `node_modules` 里，不使用 `@latest`。
普通依赖更新不会覆盖此目录。Magpie 的插件接口、agy 命令或 Google 服务仍可能
变化，因此升级必须先测试；固定源码不代表永久兼容。

升级时下载到新的、以 SHA 命名的目录，运行测试，切换单个插件的注册路径。
保留上一版本目录和私有配置备份。不要在生产目录直接 `git pull`。

## 从 Magpie UI 添加账号

打开 Providers → agy-cli → 添加账号 → **Sign in with Google · independent CLI account**。
打开 Google 链接，选择要添加的账号，再把页面显示的授权码或回调地址填回 Magpie。
Google 登录必须由账号持有人完成。插件会验证 CLI 已保存可续期身份，账号邮箱显示在额度信息中。

每次新登录使用新的随机 profile ID。Magpie 只保存 `agy-account:<uuid>` 引用与邮箱；
Google token 保存在对应账号目录，绝不保存到插件仓库。
旧的固定 `agy` 凭据不会自动变成多账号：请通过 UI 重新登录，或由管理员在停服、
备份后将已有 Linux token 迁入独立 profile，并同步修改那一个账号引用。

## 隔离及资源限制

- 每个账号拥有独立 HOME、XDG 目录、凭据、模型/额度缓存和 ACP 会话状态。
- 每个账号在独立 Bun worker 中运行上游桥接模块，避免模块级变量串号。
- 最多两个服务 worker，每个账号最多一个 ACP 会话进程；空闲 worker 可回收。
- 另预留最多两个待登录 worker。等待 Google 授权码的 CLI 不占推理槽位，
  登录完成后结束该 worker；登录失败或超时后清理。
- 模型、额度和推理 CLI 调用通过共享 flock 槽位限制为最多两个。
  帮助、版本查询及最多两个交互登录进程除外。
- 容量已满返回 503，其他 provider 的回退策略仍由 Magpie 决定。
- 额度读取遇到同账号活动请求时延后，返回上次读数并明确标注延后；不伪造新额度。
- 从 UI 退出账号后，已观察到的账号在约五秒的巡检内停止并删除其 profile。
  启动前就已删除的账号或未完成登录的残留目录，超过 16 分钟宽限期后清理。
  账号文件损坏或不可读时停止清理，避免误删。退出本地账号不等同于 Google 端撤销授权。
- Magpie 在已显示授权链接后取消登录，不一定通知插件；此时登录进程最多保留
  15 分钟，目录在 16 分钟后清理。它们使用独立的待登录名额，不占服务 worker 名额。
- worker 的父进程消失时停止其 CLI 进程组，防止插件重启后留下后台进程。

默认 profile 根目录是 `$XDG_STATE_HOME/magpie-agy-accounts`，也可使用
`AGY_MULTI_ROOT`。官方 CLI 默认是原 HOME 下的 `.local/bin/agy`，可由
`AGY_REAL_PATH` 指定。源码、账号目录和备份要分开；迁移机器时必须同时备份
Magpie 的账号引用和 profile 目录，并将备份作为凭据保密。

## 测试

```sh
bun test tests
```

测试涵盖不同账号的请求、模型、额度与路径隔离，流取消、退出清理、账号文件损坏、
容量回收，以及 Linux 上真实 worker + 模拟 CLI 的并行登录与重启恢复。
模拟身份使用 `example.invalid`，不访问 Google。真实多 Google 账号、token 续期和
生产资源压力需要部署后的单独验证；单个真实账号通过不代表多身份测试通过。

## 上游来源

基线来自 `magpie-community/plugins` 的 `packages/agy-cli` 0.1.55。
此 fork 保留已部署的共享额度标签补丁：Opus / Sonnet 属于 CLI 报告的 Claude & GPT 池，
不虚构独立额度。新代码主要位于 `multi-account/` 和 `tests/`，桥接模块只增加
worker 状态/空闲释放接口，以及让额度子进程归属 worker 进程组的改动。

原许可及来源说明见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)；
原文档见 [UPSTREAM-README.md](UPSTREAM-README.md) 和 [README.en.md](README.en.md)。
此 fork 不隶属于 Google、Magpie 或上游维护者。
