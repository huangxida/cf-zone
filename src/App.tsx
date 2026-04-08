import { createElement, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../package.json';
import type { CurrentUserProfile, CurrentUserResponse } from '../shared/current-user';
import type {
	NavigationBanner,
	NavigationErrorResponse,
	NavigationGroup,
	NavigationItem,
	NavigationResponse,
} from '../shared/navigation';

type Status = 'idle' | 'loading' | 'ready' | 'error';
type UserStatus = 'idle' | 'loading' | 'ready' | 'error';
type GroupFilter = string;
type RecordTypeFilter = 'featured' | 'all' | string;
type ThemeMode = 'system' | 'light' | 'dark';
type FilterOption = {
	value: RecordTypeFilter;
	label: string;
	count: number;
};
type ThemeOption = {
	value: ThemeMode;
	label: string;
	icon: string;
};
type MaterialMenuElement = HTMLElement & {
	open: boolean;
	show: () => void;
	close: () => void;
};
type LocalCacheResult = {
	payload: NavigationResponse | null;
	banners: NavigationBanner[];
};

const TYPE_SORT_ORDER = ['featured', 'all', 'A', 'AAAA', 'CNAME', 'HTTPS', 'MX', 'TXT', 'CAA', 'NS', 'SRV'];
const LOCAL_CACHE_KEY = 'cf-zone:navigation-cache:v1';
const THEME_PREFERENCE_KEY = 'cf-zone:theme-preference:v1';
const THEME_MENU_ANCHOR_ID = 'theme-menu-anchor';
const USER_MENU_ANCHOR_ID = 'user-menu-anchor';
const APP_VERSION = packageJson.version;
const GITHUB_RELEASES_URL = 'https://github.com/huangxida/cf-zone/releases';
const THEME_OPTIONS: ThemeOption[] = [
	{ value: 'system', label: '跟随系统', icon: 'desktop_windows' },
	{ value: 'light', label: '白色', icon: 'light_mode' },
	{ value: 'dark', label: '黑色', icon: 'dark_mode' },
];

class NavigationRequestError extends Error {
	status: number;
	banners: NavigationBanner[];

	constructor(message: string, status = 500, banners: NavigationBanner[] = []) {
		super(message);
		this.name = 'NavigationRequestError';
		this.status = status;
		this.banners = banners;
	}
}

export default function App() {
	const [status, setStatus] = useState<Status>('idle');
	const [userStatus, setUserStatus] = useState<UserStatus>('idle');
	const [clock, setClock] = useState(() => Date.now());
	const [query, setQuery] = useState('');
	const [payload, setPayload] = useState<NavigationResponse | null>(null);
	const [navigationBanners, setNavigationBanners] = useState<NavigationBanner[]>([]);
	const [currentUser, setCurrentUser] = useState<CurrentUserResponse | null>(null);
	const [errorMessage, setErrorMessage] = useState('');
	const [userErrorMessage, setUserErrorMessage] = useState('');
	const [activeGroup, setActiveGroup] = useState<GroupFilter>('');
	const [activeTypeFilter, setActiveTypeFilter] = useState<RecordTypeFilter>('featured');
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemePreference());
	const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
	const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
	const themeMenuRef = useRef<MaterialMenuElement | null>(null);
	const userMenuRef = useRef<MaterialMenuElement | null>(null);

	useEffect(() => {
		applyThemePreference(themeMode);
		writeThemePreference(themeMode);
	}, [themeMode]);

	useEffect(() => bindMaterialMenu(themeMenuRef.current, setIsThemeMenuOpen), []);
	useEffect(() => bindMaterialMenu(userMenuRef.current, setIsUserMenuOpen), []);

	useEffect(() => {
		const syncClock = () => setClock(Date.now());
		const timer = window.setInterval(syncClock, 1000);

		window.addEventListener('focus', syncClock);
		window.addEventListener('pageshow', syncClock);
		document.addEventListener('visibilitychange', syncClock);

		return () => {
			window.clearInterval(timer);
			window.removeEventListener('focus', syncClock);
			window.removeEventListener('pageshow', syncClock);
			document.removeEventListener('visibilitychange', syncClock);
		};
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const cached = readLocalCache();
		setNavigationBanners(cached.banners);

		if (cached.payload) {
			setPayload(cached.payload);
			setStatus('ready');
			return () => controller.abort();
		}

		setStatus('loading');

		void loadNavigationData({
			force: false,
			signal: controller.signal,
			hasExistingPayload: Boolean(cached.payload),
			existingBanners: cached.banners,
			setErrorMessage,
			setNavigationBanners,
			setIsRefreshing,
			setPayload,
			setStatus,
		});

		return () => controller.abort();
	}, []);

	useEffect(() => {
		const controller = new AbortController();

		void loadCurrentUser({
			signal: controller.signal,
			setCurrentUser,
			setUserErrorMessage,
			setUserStatus,
		});

		return () => controller.abort();
	}, []);

	const groups = payload?.groups ?? [];

	useEffect(() => {
		if (!groups.length) {
			return;
		}

		if (!groups.some((group) => group.title === activeGroup)) {
			setActiveGroup(groups[0]?.title ?? '');
		}
	}, [activeGroup, groups]);

	const currentGroup = useMemo(
		() => groups.find((group) => group.title === activeGroup) ?? groups[0] ?? null,
		[activeGroup, groups],
	);

	const typeOptions = useMemo(() => buildTypeOptions(currentGroup), [currentGroup]);

	useEffect(() => {
		if (!currentGroup) {
			return;
		}

		const availableFilters = new Set(typeOptions.map((option) => option.value));
		if (!availableFilters.has(activeTypeFilter)) {
			setActiveTypeFilter(getDefaultTypeFilter(currentGroup));
		}
	}, [activeTypeFilter, currentGroup, typeOptions]);

	const normalizedQuery = query.trim().toLowerCase();
	const filteredItems = useMemo(() => {
		if (!currentGroup) {
			return [];
		}

		return currentGroup.items.filter((item) => {
			if (!matchesTypeFilter(item, activeTypeFilter)) {
				return false;
			}

			if (!normalizedQuery) {
				return true;
			}

			return [item.title, item.hostname, item.recordType, item.value, item.comment, item.zoneName]
				.join(' ')
				.toLowerCase()
				.includes(normalizedQuery);
		});
	}, [activeTypeFilter, currentGroup, normalizedQuery]);

	const currentTypeLabel = typeOptions.find((option) => option.value === activeTypeFilter)?.label ?? '精选';
	const currentThemeOption = THEME_OPTIONS.find((option) => option.value === themeMode) ?? THEME_OPTIONS[0];
	const visibleNavigationBanners = useMemo(
		() => mergeNavigationBanners(payload?.banners ?? [], navigationBanners),
		[navigationBanners, payload?.banners],
	);

	async function handleForceRefresh() {
		await loadNavigationData({
			force: true,
			hasExistingPayload: Boolean(payload),
			existingBanners: navigationBanners,
			setErrorMessage,
			setNavigationBanners,
			setIsRefreshing,
			setPayload,
			setStatus,
		});
	}

	function toggleMaterialMenu(menu: MaterialMenuElement | null) {
		if (!menu) {
			return;
		}

		if (menu.open) {
			menu.close();
			return;
		}

		menu.show();
	}

	function handleThemeSelect(value: ThemeMode) {
		setThemeMode(value);
		themeMenuRef.current?.close();
	}

	function handleLogout() {
		if (!currentUser?.logoutUrl) {
			return;
		}

		userMenuRef.current?.close();
		window.location.assign(currentUser.logoutUrl);
	}

	return (
		<div className="viewport">
			<div className="hero">
				<div className="topbar">
					<div className="topbar-spacer" aria-hidden="true" />
					<div className="topbar-actions">
						<GoogleIconButton
							icon="refresh"
							label="强制刷新"
							loading={isRefreshing}
							onClick={() => void handleForceRefresh()}
						/>

						<div className="theme-menu">
							<GoogleIconButton
								buttonId={THEME_MENU_ANCHOR_ID}
								icon={currentThemeOption.icon}
								label={`主题，当前为${currentThemeOption.label}`}
								pressed={isThemeMenuOpen}
								onClick={() => toggleMaterialMenu(themeMenuRef.current)}
							/>
							<md-menu ref={themeMenuRef} anchor={THEME_MENU_ANCHOR_ID} className="theme-google-menu" quick>
								{THEME_OPTIONS.map((option) => (
									<md-menu-item
										key={option.value}
										className="theme-google-item"
										selected={themeMode === option.value ? true : undefined}
										onClick={() => handleThemeSelect(option.value)}
									>
										{renderInlineIcon(option.icon, 'theme-inline-icon', 'start')}
										<span slot="headline" className="theme-menu-label">
											{option.label}
										</span>
										{themeMode === option.value && renderInlineIcon('check', 'theme-inline-icon is-check', 'end')}
									</md-menu-item>
								))}
							</md-menu>
						</div>

						<UserMenu
							currentUser={currentUser}
							userStatus={userStatus}
							userErrorMessage={userErrorMessage}
							isOpen={isUserMenuOpen}
							menuRef={userMenuRef}
							onToggle={() => toggleMaterialMenu(userMenuRef.current)}
							onLogout={handleLogout}
						/>
					</div>
				</div>
			</div>

			<section className="search-stage">
				<label className="search-shell">
					<SearchIcon />
					<input
						type="search"
						placeholder="搜索标题、主机名、记录值或类型"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>

				<div className="filter-stack">
					<div className="filter-row">
						<p className="filter-label">域名</p>
						<div className="action-row">
							{groups.map((group) => (
								<GoogleFilterButton
									key={group.id}
									active={currentGroup?.title === group.title}
									icon="language"
									onClick={() => setActiveGroup(group.title)}
								>
									{group.title} ({group.items.length})
								</GoogleFilterButton>
							))}
						</div>
					</div>

					{currentGroup && (
						<div className="filter-row">
							<p className="filter-label">记录类型</p>
							<div className="action-row">
								{typeOptions.map((option) => (
									<GoogleFilterButton
										key={String(option.value)}
										active={activeTypeFilter === option.value}
										icon={getTypeIcon(option.value)}
										onClick={() => setActiveTypeFilter(option.value)}
									>
										{option.label} ({option.count})
									</GoogleFilterButton>
								))}
							</div>
						</div>
					)}
				</div>

				{visibleNavigationBanners.length > 0 && <NavigationBannerStack banners={visibleNavigationBanners} />}

				<div className="status-bar">
					<div className="status-meta">
						{payload && <span className="status-text">{formatUpdatedDisplay(payload.lastUpdatedAt, clock)}</span>}
						{payload?.stale && <span className="status-chip">缓存回退</span>}
						{false && errorMessage && status === 'ready' && <span className="status-chip is-warning">{errorMessage}</span>}
					</div>
				</div>
			</section>

			<main className="panel-grid panel-grid-single">
				{status === 'loading' && <LoadingState />}
				{status === 'error' && <ErrorState errorMessage={errorMessage} />}
				{status === 'ready' && !currentGroup && <EmptyState message="当前没有可展示的托管域名。" />}
				{status === 'ready' && currentGroup && filteredItems.length === 0 && (
					<EmptyState message="当前筛选条件下没有匹配的 DNS 记录。" />
				)}
				{status === 'ready' && currentGroup && filteredItems.length > 0 && (
					<ZonePanel items={filteredItems} isRefreshing={isRefreshing} />
				)}
			</main>

			<footer className="app-footer">
				<a className="app-version-link" href={GITHUB_RELEASES_URL} target="_blank" rel="noreferrer">
					v{APP_VERSION}
				</a>
			</footer>
		</div>
	);
}

function UserMenu({
	currentUser,
	userStatus,
	userErrorMessage,
	isOpen,
	menuRef,
	onToggle,
	onLogout,
}: {
	currentUser: CurrentUserResponse | null;
	userStatus: UserStatus;
	userErrorMessage: string;
	isOpen: boolean;
	menuRef: RefObject<MaterialMenuElement | null>;
	onToggle: () => void;
	onLogout: () => void;
}) {
	const profile = currentUser?.user ?? null;
	const supportingText = profile?.email || getUserMenuSupportingText(currentUser, userStatus, userErrorMessage);
	const sourceLabel = profile ? describeUserSource(currentUser?.source ?? 'none', profile.provider) : '';

	return (
		<div className="user-menu">
			<button
				id={USER_MENU_ANCHOR_ID}
				type="button"
				className={`user-trigger ${isOpen ? 'is-open' : ''}`.trim()}
				aria-label={profile ? `${profile.name}，打开用户菜单` : '打开用户菜单'}
				aria-haspopup="menu"
				aria-expanded={isOpen ? 'true' : 'false'}
				title={profile ? `${profile.name} (${profile.email})` : '用户菜单'}
				onClick={onToggle}
			>
				{userStatus === 'loading' && !profile ? (
					createElement('md-circular-progress', {
						class: 'user-avatar-spinner',
						indeterminate: true,
					})
				) : (
					<UserAvatar profile={profile} className="user-trigger-avatar" />
				)}
			</button>

			<md-menu ref={menuRef} anchor={USER_MENU_ANCHOR_ID} className="user-google-menu" quick>
				<md-menu-item className="user-google-item user-google-summary" disabled>
					<span slot="start" className="user-menu-avatar-slot">
						<UserAvatar profile={profile} className="user-menu-avatar" />
					</span>
					<span slot="headline" className="user-menu-name">
						{profile?.name ?? (userStatus === 'loading' ? '正在读取身份信息' : '当前未登录')}
					</span>
					<span slot="supporting-text" className="user-menu-supporting">
						{supportingText}
					</span>
				</md-menu-item>

				{sourceLabel && (
					<md-menu-item className="user-google-item" disabled>
						{renderInlineIcon('verified_user', 'theme-inline-icon', 'start')}
						<span slot="headline" className="theme-menu-label">
							身份来源
						</span>
						<span slot="supporting-text" className="user-menu-supporting">
							{sourceLabel}
						</span>
					</md-menu-item>
				)}

				{profile && currentUser?.logoutUrl && (
					<md-menu-item className="user-google-item" onClick={onLogout}>
						{renderInlineIcon('logout', 'theme-inline-icon', 'start')}
						<span slot="headline" className="theme-menu-label">
							退出登录
						</span>
						<span slot="supporting-text" className="user-menu-supporting">
							清除当前 Access 会话
						</span>
					</md-menu-item>
				)}
			</md-menu>
		</div>
	);
}

function UserAvatar({
	profile,
	className,
}: {
	profile: CurrentUserProfile | null;
	className?: string;
}) {
	if (profile?.avatarUrl) {
		return (
			<span className={`user-avatar ${className ?? ''}`.trim()}>
				<img src={profile.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
			</span>
		);
	}

	if (profile) {
		return <span className={`user-avatar ${className ?? ''}`.trim()}>{profile.initials}</span>;
	}

	return createElement(
		'span',
		{
			className: `user-avatar is-placeholder ${className ?? ''}`.trim(),
		},
		createElement(
			'md-icon',
			{
				class: 'user-avatar-icon',
				'aria-hidden': 'true',
			},
			'person',
		),
	);
}

function GoogleFilterButton({
	active,
	children,
	compact,
	icon,
	onClick,
}: {
	active: boolean;
	children: ReactNode;
	compact?: boolean;
	icon: string;
	onClick: () => void;
}) {
	const tagName = active ? 'md-filled-tonal-button' : 'md-elevated-button';

	return createElement(
		tagName,
		{
			class: `google-filter-button ${active ? 'is-active' : 'is-idle'} ${compact ? 'is-compact' : ''}`.trim(),
			type: 'button',
			'aria-pressed': active ? 'true' : 'false',
			onClick,
		},
		buildButtonIcon(icon),
		children,
	);
}

function GoogleIconButton({
	buttonId,
	icon,
	label,
	loading,
	pressed,
	onClick,
}: {
	buttonId?: string;
	icon: string;
	label: string;
	loading?: boolean;
	pressed?: boolean;
	onClick: () => void;
}) {
	return createElement(
		'md-outlined-icon-button',
		{
			class: 'google-icon-button',
			id: buttonId,
			type: 'button',
			disabled: loading,
			'aria-label': label,
			'aria-pressed': pressed ? 'true' : 'false',
			selected: pressed ? true : undefined,
			title: label,
			onClick,
		},
		loading
			? createElement('md-circular-progress', {
					class: 'icon-button-spinner',
					indeterminate: true,
				})
			: createElement(
					'md-icon',
					{
						class: 'button-icon',
						'aria-hidden': 'true',
					},
					icon,
				),
	);
}

function ZonePanel({
	items,
	isRefreshing,
}: {
	items: NavigationItem[];
	isRefreshing: boolean;
}) {
	return (
		<section className="group-panel">
			<div className="link-grid">
				{items.map((item, index) => (
					<RecordCard key={`${item.hostname}-${item.recordType}-${item.value}`} item={item} index={index} />
				))}
			</div>
			{isRefreshing && (
				<div className="refresh-overlay" aria-hidden="true">
					{buildOverlaySpinner()}
					<p>正在强制刷新数据</p>
				</div>
			)}
		</section>
	);
}

function RecordCard({ item, index }: { item: NavigationItem; index: number }) {
	const isStatic = !item.url;
	const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

	async function handleCopy() {
		try {
			await copyText(item.value);
			setCopyState('copied');
		} catch {
			setCopyState('failed');
		}

		window.setTimeout(() => {
			setCopyState('idle');
		}, 1400);
	}

	const content = (
		<>
			<div className="link-topline">
				<span className="link-title">{item.title}</span>
				<div className="badge-row">
					<span className="link-badge is-type">{item.recordType}</span>
					{copyState === 'copied' && <span className="link-badge is-success">已复制</span>}
					{copyState === 'failed' && <span className="link-badge is-error">失败</span>}
					<span className={`link-badge ${item.proxied ? 'is-proxied' : 'is-dns'}`}>
						{item.proxied ? 'Proxy' : 'DNS'}
					</span>
				</div>
			</div>
			{isStatic && <p className="link-detail">{item.value}</p>}
		</>
	);

	if (isStatic) {
		return (
			<button
				type="button"
				className="link-card is-static copy-card"
				style={{ animationDelay: `${index * 28}ms` }}
				onClick={() => void handleCopy()}
				title="点击复制记录值"
			>
				{content}
			</button>
		);
	}

	return (
		<a
			className="link-card"
			href={item.url}
			target="_blank"
			rel="noreferrer"
			style={{ animationDelay: `${index * 28}ms` }}
		>
			{content}
		</a>
	);
}

function LoadingState() {
	return (
		<section className="state-panel">
			<div className="loader" />
			<h2>正在同步 Cloudflare 数据</h2>
			<p>托管域名和对应 DNS 记录正在刷新，稍等片刻。</p>
		</section>
	);
}

function ErrorState({ errorMessage }: { errorMessage: string }) {
	return (
		<section className="state-panel state-error">
			<h2>导航数据暂时不可用</h2>
			<p>{errorMessage}</p>
		</section>
	);
}

function EmptyState({ message }: { message: string }) {
	return (
		<section className="state-panel">
			<h2>当前没有可展示内容</h2>
			<p>{message}</p>
		</section>
	);
}

function SearchIcon() {
	return createElement(
		'md-icon',
		{
			class: 'search-icon search-icon-md',
			'aria-hidden': 'true',
		},
		'search',
	);
}

function NavigationBannerStack({ banners }: { banners: NavigationBanner[] }) {
	return (
		<div className="banner-stack" role="status" aria-live="polite">
			{banners.map((banner) => (
				<md-outlined-card key={buildBannerKey(banner)} className={`banner-card banner-${banner.level}`}>
					<div className="banner-card-inner">
						<md-icon className="banner-icon-symbol" aria-hidden="true">
							{getBannerIcon(banner.level)}
						</md-icon>
						<div className="banner-copy">
							<p className="banner-label">{getBannerLabel(banner.level)}</p>
							<p className="banner-message">{banner.message}</p>
							{banner.detail && <p className="banner-detail">{banner.detail}</p>}
						</div>
					</div>
				</md-outlined-card>
			))}
		</div>
	);
}

function buildTypeOptions(group: NavigationGroup | null): FilterOption[] {
	if (!group) {
		return [];
	}

	const counts = new Map<string, number>();
	let featuredCount = 0;

	for (const item of group.items) {
		if (item.featured) {
			featuredCount += 1;
		}
		counts.set(item.recordType, (counts.get(item.recordType) ?? 0) + 1);
	}

	const typeOptions = [...counts.entries()]
		.sort((left, right) => compareTypeOrder(left[0], right[0]))
		.map(([type, count]) => ({
			value: type,
			label: type,
			count,
		}));

	return [
		{
			value: 'featured',
			label: '精选',
			count: featuredCount,
		},
		{
			value: 'all',
			label: '全部',
			count: group.items.length,
		},
		...typeOptions,
	];
}

function getDefaultTypeFilter(group: NavigationGroup): RecordTypeFilter {
	return group.items.some((item) => item.featured) ? 'featured' : 'all';
}

function matchesTypeFilter(item: NavigationItem, filter: RecordTypeFilter): boolean {
	if (filter === 'featured') {
		return item.featured;
	}

	if (filter === 'all') {
		return true;
	}

	return item.recordType === filter;
}

function compareTypeOrder(left: string, right: string) {
	const leftIndex = TYPE_SORT_ORDER.indexOf(left);
	const rightIndex = TYPE_SORT_ORDER.indexOf(right);

	if (leftIndex !== -1 || rightIndex !== -1) {
		if (leftIndex === -1) {
			return 1;
		}
		if (rightIndex === -1) {
			return -1;
		}
		return leftIndex - rightIndex;
	}

	return left.localeCompare(right, 'en');
}

function formatUpdatedDisplay(value: string | null | undefined, now = Date.now()) {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		return '上次更新时间: --';
	}

	const diff = now - parsed;
	if (Number.isFinite(diff) && diff >= 0 && diff < 60_000) {
		return '上次更新时间: 刚刚';
	}

	return `上次更新时间: ${new Intl.DateTimeFormat('zh-CN', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	}).format(new Date(parsed))}`;
}

function normalizeThemePreference(value: unknown): ThemeMode {
	if (value === 'light' || value === 'dark' || value === 'system') {
		return value;
	}

	return 'system';
}

function readThemePreference(): ThemeMode {
	if (typeof window === 'undefined') {
		return 'system';
	}

	try {
		return normalizeThemePreference(window.localStorage.getItem(THEME_PREFERENCE_KEY));
	} catch {
		return 'system';
	}
}

function writeThemePreference(value: ThemeMode) {
	if (typeof window === 'undefined') {
		return;
	}

	try {
		window.localStorage.setItem(THEME_PREFERENCE_KEY, value);
	} catch {
	}
}

function applyThemePreference(value: ThemeMode) {
	if (typeof document === 'undefined') {
		return;
	}

	document.documentElement.dataset.theme = value;
}

function readLocalCache(): LocalCacheResult {
	if (typeof window === 'undefined') {
		return { payload: null, banners: [] };
	}

	try {
		const raw = window.localStorage.getItem(LOCAL_CACHE_KEY);
		if (!raw) {
			return { payload: null, banners: [] };
		}

		return {
			payload: normalizeNavigationResponse(JSON.parse(raw)),
			banners: [],
		};
	} catch (error) {
		return {
			payload: null,
			banners: [
				createClientBanner(
					'local-cache-read-failed',
					'warning',
					'读取浏览器本地缓存失败，本次将直接请求服务端数据。',
					getClientErrorDetail(error),
				),
			],
		};
	}
}

function writeLocalCache(payload: NavigationResponse): NavigationBanner[] {
	if (typeof window === 'undefined') {
		return [];
	}

	try {
		window.localStorage.setItem(
			LOCAL_CACHE_KEY,
			JSON.stringify({
				groups: payload.groups,
				lastUpdatedAt: payload.lastUpdatedAt,
				stale: false,
				source: 'cache',
				banners: [],
			} satisfies NavigationResponse),
		);
		return [];
	} catch (error) {
		return [
			createClientBanner(
				'local-cache-write-failed',
				'warning',
				'写入浏览器本地缓存失败，刷新页面后可能需要重新请求数据。',
				getClientErrorDetail(error),
			),
		];
	}
}

async function loadNavigationData({
	force,
	signal,
	hasExistingPayload,
	existingBanners,
	setErrorMessage,
	setNavigationBanners,
	setIsRefreshing,
	setPayload,
	setStatus,
}: {
	force: boolean;
	signal?: AbortSignal;
	hasExistingPayload: boolean;
	existingBanners: NavigationBanner[];
	setErrorMessage: (value: string) => void;
	setNavigationBanners: (value: NavigationBanner[]) => void;
	setIsRefreshing: (value: boolean) => void;
	setPayload: (value: NavigationResponse) => void;
	setStatus: (value: Status) => void;
}) {
	setIsRefreshing(force);
	setErrorMessage('');

	if (!hasExistingPayload) {
		setStatus('loading');
	}

	try {
		const data = await requestSitesV2(force, signal);
		setPayload(data);
		setNavigationBanners(mergeNavigationBanners(retainPersistentBanners(existingBanners), writeLocalCache(data)));
		setStatus('ready');
	} catch (error) {
		if (signal?.aborted) {
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		setErrorMessage(message);
		setNavigationBanners(
			mergeNavigationBanners(retainPersistentBanners(existingBanners), getRequestErrorBanners(error, message)),
		);

		if (!hasExistingPayload) {
			setStatus('error');
		}
	} finally {
		if (force) {
			setIsRefreshing(false);
		}
	}
}

async function loadCurrentUser({
	signal,
	setCurrentUser,
	setUserErrorMessage,
	setUserStatus,
}: {
	signal?: AbortSignal;
	setCurrentUser: (value: CurrentUserResponse | null) => void;
	setUserErrorMessage: (value: string) => void;
	setUserStatus: (value: UserStatus) => void;
}) {
	setUserStatus('loading');
	setUserErrorMessage('');

	try {
		const data = await requestCurrentUser(signal);
		if (signal?.aborted) {
			return;
		}

		setCurrentUser(data);
		setUserStatus('ready');
	} catch (error) {
		if (signal?.aborted) {
			return;
		}

		setCurrentUser(null);
		setUserStatus('error');
		setUserErrorMessage(error instanceof Error ? error.message : String(error));
	}
}

async function requestSites(force: boolean, signal?: AbortSignal): Promise<NavigationResponse> {
	const endpoint = force ? '/api/sites?refresh=1' : '/api/sites';
	const response = await fetch(endpoint, { signal });

	if (!response.ok) {
		throw new Error('导航数据加载失败');
	}

	const payload = normalizeNavigationResponse(await response.json());
	if (!payload) {
		throw new Error('导航数据格式不正确');
	}

	return payload;
}

async function requestSitesV2(
	force: boolean,
	signal?: AbortSignal,
): Promise<NavigationResponse> {
	const endpoint = force ? '/api/sites?refresh=1' : '/api/sites';
	const response = await fetch(endpoint, { signal });
	const rawPayload = (await response.json().catch(() => null)) as NavigationResponse | NavigationErrorResponse | null;

	if (!response.ok) {
		const normalizedError = normalizeNavigationErrorResponse(rawPayload);
		throw new NavigationRequestError(
			normalizedError?.error || '导航数据加载失败',
			response.status,
			normalizedError?.banners ?? [],
		);
	}

	const payload = normalizeNavigationResponse(rawPayload);
	if (!payload) {
		throw new NavigationRequestError('导航数据格式不正确', response.status, [
			createClientBanner('navigation-payload-invalid', 'error', '服务端返回了无法识别的导航数据。'),
		]);
	}

	return payload;
}

async function requestCurrentUser(signal?: AbortSignal): Promise<CurrentUserResponse> {
	const response = await fetch('/api/me', { signal });

	if (!response.ok) {
		throw new Error('鐢ㄦ埛淇℃伅鍔犺浇澶辫触');
	}

	return (await response.json()) as CurrentUserResponse;
}

async function copyText(value: string) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(value);
		return;
	}

	const textarea = document.createElement('textarea');
	textarea.value = value;
	textarea.setAttribute('readonly', 'true');
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	textarea.select();

	const copied = document.execCommand('copy');
	document.body.removeChild(textarea);

	if (!copied) {
		throw new Error('copy failed');
	}
}

function getTypeIcon(value: RecordTypeFilter) {
	switch (value) {
		case 'featured':
			return 'star';
		case 'all':
			return 'apps';
		case 'MX':
			return 'mail';
		case 'TXT':
			return 'article';
		case 'CAA':
			return 'verified';
		case 'NS':
			return 'account_tree';
		case 'SRV':
			return 'hub';
		default:
			return 'dns';
	}
}

function buildButtonIcon(icon: string, loading = false) {
	if (loading) {
		return createElement('md-circular-progress', {
			slot: 'icon',
			class: 'button-spinner',
			indeterminate: true,
		});
	}

	return createElement(
		'md-icon',
		{
			slot: 'icon',
			class: 'button-icon',
			'aria-hidden': 'true',
		},
		icon,
	);
}

function buildOverlaySpinner() {
	return createElement('md-circular-progress', {
		class: 'overlay-spinner',
		indeterminate: true,
	});
}

function renderInlineIcon(icon: string, className: string, slot?: string) {
	return createElement(
		'md-icon',
		{
			class: className,
			'aria-hidden': 'true',
			slot,
		},
		icon,
	);
}

function bindMaterialMenu(
	menu: MaterialMenuElement | null,
	setOpenState: (value: boolean) => void,
) {
	if (!menu) {
		return undefined;
	}

	const handleOpened = () => setOpenState(true);
	const handleClosed = () => setOpenState(false);

	menu.addEventListener('opened', handleOpened);
	menu.addEventListener('closed', handleClosed);

	return () => {
		menu.removeEventListener('opened', handleOpened);
		menu.removeEventListener('closed', handleClosed);
	};
}

function getUserMenuSupportingText(
	currentUser: CurrentUserResponse | null,
	userStatus: UserStatus,
	userErrorMessage: string,
) {
	if (userStatus === 'loading') {
		return '正在读取身份信息';
	}

	if (userErrorMessage) {
		return userErrorMessage;
	}

	if (currentUser?.source === 'mock') {
		return '本地预览身份';
	}

		return '本地预览未接入 Access';
}

function describeUserSource(source: CurrentUserResponse['source'], provider: string | null) {
	switch (source) {
		case 'access':
			return provider ? `${provider} · Cloudflare Access` : 'Cloudflare Access';
		case 'header':
			return 'Cloudflare Access 请求头';
		case 'mock':
			return '本地预览 Mock 身份';
		default:
			return '';
	}
}

function normalizeNavigationResponse(value: unknown): NavigationResponse | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const candidate = value as {
		groups?: unknown;
		lastUpdatedAt?: unknown;
		cachedAt?: unknown;
		stale?: unknown;
		source?: unknown;
		banners?: unknown;
	};

	if (!Array.isArray(candidate.groups)) {
		return null;
	}

	return {
		groups: candidate.groups as NavigationGroup[],
		lastUpdatedAt:
			typeof candidate.lastUpdatedAt === 'string'
				? candidate.lastUpdatedAt
				: typeof candidate.cachedAt === 'string'
					? candidate.cachedAt
					: null,
		stale: typeof candidate.stale === 'boolean' ? candidate.stale : false,
		source: candidate.source === 'live' ? 'live' : 'cache',
		banners: normalizeNavigationBanners(candidate.banners),
	};
}

function normalizeNavigationErrorResponse(value: unknown): NavigationErrorResponse | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const candidate = value as {
		error?: unknown;
		detail?: unknown;
		banners?: unknown;
	};

	if (typeof candidate.error !== 'string' || !candidate.error.trim()) {
		return null;
	}

	return {
		error: candidate.error,
		detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
		banners: normalizeNavigationBanners(candidate.banners),
	};
}

function normalizeNavigationBanners(value: unknown): NavigationBanner[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((entry): entry is NavigationBanner => Boolean(entry) && typeof entry === 'object')
		.map((entry) => {
			const candidate = entry as {
				code?: unknown;
				level?: unknown;
				message?: unknown;
				detail?: unknown;
			};

			return {
				code: typeof candidate.code === 'string' && candidate.code.trim() ? candidate.code : 'unknown',
				level:
					candidate.level === 'info' || candidate.level === 'warning' || candidate.level === 'error'
						? candidate.level
						: 'warning',
				message:
					typeof candidate.message === 'string' && candidate.message.trim()
						? candidate.message
						: '出现了一条未命名的状态消息。',
				detail: typeof candidate.detail === 'string' && candidate.detail.trim() ? candidate.detail : null,
			};
		});
}

function mergeNavigationBanners(...batches: NavigationBanner[][]): NavigationBanner[] {
	const merged = new Map<string, NavigationBanner>();

	for (const batch of batches) {
		for (const banner of batch) {
			merged.set(buildBannerKey(banner), banner);
		}
	}

	return [...merged.values()];
}

function retainPersistentBanners(banners: NavigationBanner[]): NavigationBanner[] {
	return banners.filter((banner) => banner.code.startsWith('local-cache-'));
}

function buildBannerKey(banner: NavigationBanner): string {
	return `${banner.code}:${banner.level}:${banner.message}:${banner.detail ?? ''}`;
}

function getBannerIcon(level: NavigationBanner['level']): string {
	switch (level) {
		case 'error':
			return 'error';
		case 'info':
			return 'info';
		default:
			return 'warning';
	}
}

function getBannerLabel(level: NavigationBanner['level']) {
	switch (level) {
		case 'error':
			return '错误';
		case 'info':
			return '提示';
		default:
			return '警告';
	}
}

function createClientBanner(
	code: string,
	level: NavigationBanner['level'],
	message: string,
	detail?: string | null,
): NavigationBanner {
	return {
		code,
		level,
		message,
		detail: detail?.trim() || null,
	};
}

function getClientErrorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getRequestErrorBanners(error: unknown, fallbackMessage: string): NavigationBanner[] {
	if (error instanceof NavigationRequestError && error.banners.length > 0) {
		return error.banners;
	}

	return [createClientBanner('navigation-request-failed', 'error', fallbackMessage)];
}
