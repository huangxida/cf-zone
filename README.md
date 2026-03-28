# CF Zone

一个部署在 Cloudflare Workers 上的私有导航页。它会读取当前 Cloudflare 账号下所有 Zone 的 DNS 记录，只展示 `comment` 命中导航规范的站点入口，并通过 Cloudflare Access + Google OAuth 限制访问。

## 功能

- 聚合当前账号下全部 Zone 的 DNS 记录
- 仅展示 `A`、`AAAA`、`CNAME`、`HTTPS` 记录
- 仅收录 `comment` 形如 `[nav] 标题` 或 `[nav/分组] 标题` 的记录
- 通过 `/api/sites` 提供导航数据
- 5 分钟缓存 Cloudflare API 结果，失败时回退到旧缓存
- 适合配到 `nav.<your-zone>` 这样的私有子域名

## 本地开发

```bash
npm install
npm run cf-typegen
npm run dev
```

本地需要准备：

- `CF_ACCOUNT_ID`
- `CF_NAV_API_TOKEN`

建议把只读 token 放到 `.dev.vars`，格式参考 [`.dev.vars.example`](./.dev.vars.example)。

## Cloudflare 变量与密钥

`wrangler.jsonc` 里保留了以下变量：

- `CF_ACCOUNT_ID`: Cloudflare account id
- `CACHE_TTL_SECONDS`: DNS 数据缓存秒数，默认 `300`

运行时 secret：

- `CF_NAV_API_TOKEN`: 只读 token，只需 `Zone Read` + `DNS Read`

## DNS comment 规范

以下记录会出现在导航页中：

- `[nav] 博客`
- `[nav/运维] 控制台`
- `[nav/工具] 下载页`

不会展示：

- 不支持的记录类型
- 通配符记录
- `_acme-challenge` 这类以下划线开头的服务记录

## 部署

### Workers Builds

1. 在 Cloudflare Dashboard 创建 Worker，名称固定为 `cf-zone`
2. 连接 GitHub 仓库 `huangxida/cf-zone`
3. 把生产分支设为 `main`
4. 在 Worker Variables / Secrets 中设置：
   - `CF_ACCOUNT_ID`
   - `CACHE_TTL_SECONDS`
   - `CF_NAV_API_TOKEN`
5. 绑定自定义域名，优先使用 `nav.<your-zone>`

### Access + Google OAuth

需要在 Cloudflare Zero Trust 中完成两项配置：

1. 创建 Google Identity Provider，填入 Google OAuth `client_id` 和 `client_secret`
2. 为 `nav.<your-zone>` 创建 Access Application，只允许你的 Gmail 登录

## 手动部署

```bash
npm run deploy
```

该命令会先 `vite build`，再部署 `dist/cf_zone/wrangler.json`。
