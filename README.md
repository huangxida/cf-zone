# CF Zone

一个部署在 Cloudflare Workers 上的私有 DNS 导航页。

它会读取当前 Cloudflare 账号下托管域名的 DNS 记录，按托管域名分组展示，并提供搜索、类型切换、缓存、强制刷新、主题切换，以及右上角的用户菜单。页面适合挂在类似 `nav.example.com` 这样的私有入口上，配合 Cloudflare Access 做 Google 登录后访问。

## 当前功能

- 按 Cloudflare 托管域名分组展示 DNS 记录
- 默认展示精选入口，也可切换为 `全部`、`A`、`MX`、`TXT` 等记录类型
- 支持搜索标题、主机名、记录值和记录类型
- 可跳转记录直接打开站点，不可跳转记录支持点击复制记录值
- 前端使用 `localStorage` 做最近一次成功结果缓存
- Worker 侧使用 Cloudflare KV 持久化缓存 DNS 数据，默认 TTL 为 `30` 天
- 提供强制刷新按钮；“上次更新时间”表示最近一次成功回源刷新时间，读取缓存不会更新该时间
- 支持 `跟随系统 / 白色 / 黑色` 主题
- 右上角提供用户头像菜单，支持显示登录用户信息和退出登录
- 本地预览下若未接入 Access，可自动走 mock 身份兜底

## 技术栈

- Cloudflare Workers
- Cloudflare Workers Static Assets
- React 19
- Vite 7
- Material Web
- TypeScript
- Vitest

## 数据来源

### `/api/sites`

Worker 会调用 Cloudflare API：

- 读取当前账号下的 Zone
- 读取各 Zone 下的 DNS 记录
- 归一化后返回前端使用的导航数据

页面中的精选记录默认来自“有价值的站点入口”，并保留其他记录类型供切换查看。

### `/api/me`

Worker 提供当前用户接口，优先级如下：

1. Cloudflare Access `get-identity`
2. Access 请求头回退
3. 本地 mock 用户
4. 本地 `localhost / 127.0.0.1` 预览时，使用 `MOCK_USER_*` 或默认 preview 用户兜底

正式上线后，右上角用户菜单会优先展示真实 Access 用户信息；如果 Access 返回头像，则直接显示头像，否则回退为缩写头像。

## 本地开发

```bash
npm install
npm run cf-typegen
npm run dev
```

如果要查看生产构建效果：

```bash
npm run build
npm run preview
```

## 环境变量

参考 [`.dev.vars.example`](./.dev.vars.example)。

### 必需

- `CF_ACCOUNT_ID`

### 读取真实 DNS 数据

推荐：

- `CF_NAV_API_TOKEN`

权限最小化即可：

- `Zone Read`
- `DNS Read`

### Access 用户信息

- `CF_ACCESS_TEAM_DOMAIN`

示例：

```bash
CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
```

Worker 会通过该域名访问 Cloudflare Access 的身份接口。

### 本地预览 mock 用户

可选：

- `MOCK_USER_NAME`
- `MOCK_USER_EMAIL`
- `MOCK_USER_AVATAR_URL`

如果只是本地调界面，不想依赖真实 Access，可以直接在 `.dev.vars` 里配置这些值。

### 兼容的 legacy 本地认证

仅建议本地调试使用：

- `CF_AUTH_EMAIL`
- `CF_GLOBAL_API_KEY`

当没有 `CF_NAV_API_TOKEN` 时，Worker 会回退到 `X-Auth-Email + X-Auth-Key` 认证。

## DNS 展示规则

页面会按托管域名聚合所有 DNS 记录，但默认先展示“精选”记录。

当前记录处理规则：

- 支持 `A`、`AAAA`、`CNAME`、`HTTPS`、`MX`、`TXT` 等类型的展示与筛选
- 精选入口会优先展示更像站点入口的记录
- 某些主机名可配置固定跳转路径，例如 `dash-*` 系列入口
- `sub-*` 这类不需要展示的记录可以在归一化逻辑里过滤

如果你后续需要继续调整规则，核心逻辑在：

- [`shared/navigation.ts`](./shared/navigation.ts)

## 主题与交互

- 搜索框、筛选按钮和菜单使用 Google / Material 风格
- 主题切换使用 Material Web 组件
- 右上角用户菜单支持：
  - 头像或缩写
  - 姓名
  - 邮箱
  - 退出登录

## Cloudflare 部署

### Wrangler

```bash
npm run deploy
```

该命令会先执行构建，再部署 `dist/cf_zone/wrangler.json`。

### Dashboard / Workers Builds

建议配置：

1. 在 Cloudflare Dashboard 中创建 Worker：`cf-zone`
2. 连接 GitHub 仓库：`huangxida/cf-zone`
3. Workers Builds 的生产分支仍使用 `main`
4. 配置变量与密钥：
   - `CF_ACCOUNT_ID`
   - `CACHE_TTL_SECONDS`
   - `CF_ACCESS_TEAM_DOMAIN`
   - `CF_NAV_API_TOKEN`
5. 创建并绑定一个 Workers KV namespace 到 `NAV_CACHE_KV`

如果要改为“打新 tag 才发布生产环境”，请使用 `.github/workflows/deploy.yml`。
当前仓库的 GitHub Actions 已配置为在推送新 tag 时执行部署。
6. 在 `wrangler.jsonc` 中替换 `REPLACE_WITH_NAV_CACHE_KV_ID` / `REPLACE_WITH_NAV_CACHE_KV_PREVIEW_ID`
7. 绑定自定义域名，例如：
   - `nav.example.com`

## Cloudflare Access

如果要让页面只允许 Google 登录后访问，建议这样配：

1. 在 Cloudflare Zero Trust 中接入 Google 身份提供商
2. 给页面域名创建一个 Access Application
3. 只允许指定邮箱访问
4. 在 Worker 环境变量里配置 `CF_ACCESS_TEAM_DOMAIN`

这样 `/api/me` 就能读到当前登录用户，并在右上角展示头像/邮箱/退出入口。

## 脚本

```bash
npm run dev
npm run build
npm run preview
npm run test
npm run test:watch
npm run cf-typegen
npm run deploy
```
