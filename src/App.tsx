import { useEffect, useMemo, useState } from 'react';
import type { NavigationResponse } from '../shared/navigation';

type Status = 'idle' | 'loading' | 'ready' | 'error';

export default function App() {
	const [status, setStatus] = useState<Status>('idle');
	const [query, setQuery] = useState('');
	const [payload, setPayload] = useState<NavigationResponse | null>(null);
	const [errorMessage, setErrorMessage] = useState('');

	useEffect(() => {
		const controller = new AbortController();
		setStatus('loading');

		fetch('/api/sites', { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) {
					throw new Error('导航数据加载失败');
				}
				return (await response.json()) as NavigationResponse;
			})
			.then((data) => {
				setPayload(data);
				setStatus('ready');
			})
			.catch((error) => {
				if (controller.signal.aborted) {
					return;
				}
				setErrorMessage(error instanceof Error ? error.message : String(error));
				setStatus('error');
			});

		return () => controller.abort();
	}, []);

	const normalizedQuery = query.trim().toLowerCase();
	const filteredGroups = useMemo(() => {
		if (!payload) {
			return [];
		}

		return payload.groups
			.map((group) => ({
				...group,
				items: group.items.filter((item) => {
					if (!normalizedQuery) {
						return true;
					}
					return [item.title, item.hostname, item.group, item.zoneName]
						.join(' ')
						.toLowerCase()
						.includes(normalizedQuery);
				}),
			}))
			.filter((group) => group.items.length > 0);
	}, [normalizedQuery, payload]);

	const totalItems = filteredGroups.reduce((sum, group) => sum + group.items.length, 0);

	return (
		<div className="shell">
			<div className="ambient ambient-left" />
			<div className="ambient ambient-right" />
			<header className="hero">
				<div className="hero-copy">
					<p className="eyebrow">Cloudflare Zone Portal</p>
					<h1>把你在 CF 里维护的站点入口收成一个可搜索的私有总控台。</h1>
					<p className="lede">
						页面只展示 DNS comment 命中导航规范的站点，默认按分组聚合，并通过 Access
						限制为你的 Google 账号可见。
					</p>
				</div>
				<div className="hero-panel">
					<div className="meta-card">
						<span>状态</span>
						<strong>{statusLabel(status)}</strong>
					</div>
					<div className="meta-card">
						<span>缓存时间</span>
						<strong>{payload ? formatDate(payload.cachedAt) : '等待中'}</strong>
					</div>
					<div className="meta-card">
						<span>收录数量</span>
						<strong>{payload ? totalItems : '0'}</strong>
					</div>
				</div>
			</header>

			<main className="content">
				<section className="toolbar">
					<label className="search">
						<span>搜索站点</span>
						<input
							type="search"
							placeholder="输入标题、主机名或分组"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className="hint">
						comment 规范：<code>[nav] 标题</code> 或 <code>[nav/分组] 标题</code>
					</div>
				</section>

				{status === 'loading' && <LoadingState />}
				{status === 'error' && <ErrorState errorMessage={errorMessage} />}
				{status === 'ready' && payload && filteredGroups.length === 0 && <EmptyState />}
				{status === 'ready' && payload && filteredGroups.length > 0 && (
					<>
						{payload.stale && (
							<div className="banner">
								当前展示的是缓存数据，Cloudflare API 刚刚刷新失败了。你仍可继续访问现有入口。
							</div>
						)}
						<div className="groups">
							{filteredGroups.map((group) => (
								<section className="group" key={group.id}>
									<div className="group-header">
										<h2>{group.title}</h2>
										<span>{group.items.length} 个入口</span>
									</div>
									<div className="grid">
										{group.items.map((item) => (
											<a className="card" key={item.url} href={item.url} target="_blank" rel="noreferrer">
												<div className="card-top">
													<p className="card-title">{item.title}</p>
													<span className={`pill ${item.proxied ? 'pill-proxied' : 'pill-dns'}`}>
														{item.proxied ? 'Proxy' : 'DNS Only'}
													</span>
												</div>
												<p className="card-host">{item.hostname}</p>
												<div className="card-meta">
													<span>{item.recordType}</span>
													<span>{item.zoneName}</span>
												</div>
											</a>
										))}
									</div>
								</section>
							))}
						</div>
					</>
				)}
			</main>
		</div>
	);
}

function LoadingState() {
	return (
		<div className="state-panel">
			<div className="spinner" />
			<p>正在从 Cloudflare 拉取可展示的站点记录。</p>
		</div>
	);
}

function ErrorState({ errorMessage }: { errorMessage: string }) {
	return (
		<div className="state-panel state-error">
			<h2>导航数据暂时不可用</h2>
			<p>{errorMessage}</p>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="state-panel">
			<h2>还没有可展示的入口</h2>
			<p>给 DNS 记录补上指定格式的 comment，例如 <code>[nav] 博客</code> 或 <code>[nav/运维] 面板</code>。</p>
		</div>
	);
}

function statusLabel(status: Status) {
	switch (status) {
		case 'loading':
			return '正在同步';
		case 'ready':
			return '就绪';
		case 'error':
			return '失败';
		default:
			return '待启动';
	}
}

function formatDate(value: string) {
	return new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(value));
}
