import {
	groupItems,
	normalizeRecord,
	type CloudflareApiEnvelope,
	type CloudflareDnsRecord,
	type CloudflareZone,
	type NavigationResponse,
} from '../shared/navigation';
import type { CurrentUserProfile, CurrentUserResponse } from '../shared/current-user';

type Env = {
	ASSETS: Fetcher;
	CF_ACCOUNT_ID: string;
	CACHE_TTL_SECONDS?: string;
	ENABLE_DEMO_MODE?: string;
	CF_NAV_API_TOKEN?: string;
	CF_AUTH_EMAIL?: string;
	CF_GLOBAL_API_KEY?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	MOCK_USER_NAME?: string;
	MOCK_USER_EMAIL?: string;
	MOCK_USER_AVATAR_URL?: string;
};

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const CACHE_URL = 'https://cf-zone.internal/api/sites';
const DEFAULT_CACHE_TTL_SECONDS = 300;

type CachedPayload = NavigationResponse;
type AccessIdentity = {
	name?: unknown;
	email?: unknown;
	picture?: unknown;
	avatar?: unknown;
	idp?: {
		type?: unknown;
	} | null;
	oidc_fields?: Record<string, unknown> | null;
	custom?: Record<string, unknown> | null;
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/healthz') {
			return Response.json({ ok: true, now: new Date().toISOString() });
		}

		if (url.pathname === '/api/sites') {
			return handleSitesRequest(request, env, ctx);
		}

		if (url.pathname === '/api/me') {
			return handleCurrentUserRequest(request, env);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function handleSitesRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (env.ENABLE_DEMO_MODE === 'true') {
		return jsonResponse(buildDemoPayload());
	}

	const cache = caches.default;
	const url = new URL(request.url);
	const cacheKey = new Request(CACHE_URL, { headers: { accept: 'application/json' } });
	const cachedResponse = await cache.match(cacheKey);
	const cachedPayload = cachedResponse ? ((await cachedResponse.json()) as CachedPayload) : null;
	const cacheTtlSeconds = parseCacheTtl(env.CACHE_TTL_SECONDS);
	const forceRefresh = url.searchParams.get('refresh') === '1';

	if (!forceRefresh && cachedPayload && !isExpired(cachedPayload.cachedAt, cacheTtlSeconds)) {
		return jsonResponse(cachedPayload);
	}

	try {
		const freshPayload = await buildNavigationPayload(env);
		const response = jsonResponse(freshPayload);
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	} catch (error) {
		if (cachedPayload) {
			return jsonResponse({
				...cachedPayload,
				stale: true,
				source: 'cache',
			});
		}

		return jsonResponse(
			{
				error: '无法从 Cloudflare 读取导航数据。',
				detail: error instanceof Error ? error.message : String(error),
			},
			503,
		);
	}
}

async function handleCurrentUserRequest(request: Request, env: Env): Promise<Response> {
	const currentUser = await resolveCurrentUser(request, env);

	return jsonResponse({
		authenticated: Boolean(currentUser.user),
		user: currentUser.user,
		logoutUrl: currentUser.user ? buildLogoutUrl(request) : null,
		source: currentUser.source,
	} satisfies CurrentUserResponse);
}

function buildDemoPayload(): NavigationResponse {
	return {
		groups: [
			{
				id: 'example.com',
				title: 'example.com',
				items: [
					{
						group: 'example.com',
						title: '主站',
						hostname: 'example.com',
						url: 'https://example.com',
						recordType: 'A',
						proxied: true,
						comment: '[nav] 主站',
						zoneName: 'example.com',
						value: '203.0.113.10',
						featured: true,
					},
					{
						group: 'example.com',
						title: '文档',
						hostname: 'docs.example.com',
						url: 'https://docs.example.com',
						recordType: 'CNAME',
						proxied: true,
						comment: '[nav] 文档',
						zoneName: 'example.com',
						value: 'pages.example.net',
						featured: true,
					},
					{
						group: 'example.com',
						title: 'spf.example.com',
						hostname: 'spf.example.com',
						url: null,
						recordType: 'TXT',
						proxied: false,
						comment: 'v=spf1 include:_spf.google.com ~all',
						zoneName: 'example.com',
						value: 'v=spf1 include:_spf.google.com ~all',
						featured: false,
					},
				],
			},
		],
		cachedAt: new Date().toISOString(),
		stale: false,
		source: 'cache',
	};
}

async function resolveCurrentUser(
	request: Request,
	env: Env,
): Promise<Pick<CurrentUserResponse, 'user' | 'source'>> {
	const accessUser = await fetchAccessIdentity(request, env);
	if (accessUser) {
		return {
			user: accessUser,
			source: 'access',
		};
	}

	const headerEmail = readHeader(request.headers, 'cf-access-authenticated-user-email');
	if (headerEmail) {
		return {
			user: createUserProfile({
				email: headerEmail,
				name: readHeader(request.headers, 'cf-access-authenticated-user-name') ?? undefined,
				avatarUrl: null,
				provider: 'cloudflare-access',
			}),
			source: 'header',
		};
	}

	const mockUser = buildMockUser(env);
	if (mockUser) {
		return {
			user: mockUser,
			source: 'mock',
		};
	}

	const localPreviewUser = buildLocalPreviewUser(request, env);
	if (localPreviewUser) {
		return {
			user: localPreviewUser,
			source: 'mock',
		};
	}

	return {
		user: null,
		source: 'none',
	};
}

async function fetchAccessIdentity(request: Request, env: Env): Promise<CurrentUserProfile | null> {
	const teamDomain = normalizeAccessTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
	if (!teamDomain) {
		return null;
	}

	try {
		const headers = new Headers({
			accept: 'application/json',
		});
		copyRequestHeader(headers, request.headers, 'cookie');
		copyRequestHeader(headers, request.headers, 'cf-access-jwt-assertion');
		copyRequestHeader(headers, request.headers, 'user-agent');

		const response = await fetch(`https://${teamDomain}/cdn-cgi/access/get-identity`, {
			headers,
		});

		if (!response.ok) {
			return null;
		}

		const identity = (await response.json()) as AccessIdentity;
		const email = pickFirstString(identity.email, identity.oidc_fields?.email, identity.custom?.email);
		if (!email) {
			return null;
		}

		return createUserProfile({
			email,
			name: pickFirstString(identity.name, identity.oidc_fields?.name, identity.custom?.name) ?? undefined,
			avatarUrl:
				pickFirstString(
					identity.picture,
					identity.avatar,
					identity.oidc_fields?.picture,
					identity.oidc_fields?.avatar,
					identity.oidc_fields?.profile_picture,
					identity.custom?.picture,
					identity.custom?.avatar,
					identity.custom?.profile_picture,
				) ?? null,
			provider: pickFirstString(identity.idp?.type) ?? 'cloudflare-access',
		});
	} catch {
		return null;
	}
}

function buildMockUser(env: Env): CurrentUserProfile | null {
	const email = env.MOCK_USER_EMAIL?.trim();
	const name = env.MOCK_USER_NAME?.trim();
	const avatarUrl = env.MOCK_USER_AVATAR_URL?.trim();

	if (!email && !name && !avatarUrl) {
		return null;
	}

	return createUserProfile({
		email: email || 'preview@localhost',
		name: name || undefined,
		avatarUrl: avatarUrl || null,
		provider: 'mock',
	});
}

function buildLocalPreviewUser(request: Request, env: Env): CurrentUserProfile | null {
	const hostname = new URL(request.url).hostname;
	if (!isLoopbackHost(hostname) || !env.CF_AUTH_EMAIL?.trim()) {
		return null;
	}

	return createUserProfile({
		email: env.CF_AUTH_EMAIL,
		name: env.MOCK_USER_NAME?.trim() || undefined,
		avatarUrl: env.MOCK_USER_AVATAR_URL?.trim() || null,
		provider: 'local-preview',
	});
}

function createUserProfile({
	email,
	name,
	avatarUrl,
	provider,
}: {
	email: string;
	name?: string;
	avatarUrl?: string | null;
	provider?: string | null;
}): CurrentUserProfile {
	const normalizedEmail = email.trim().toLowerCase();
	const normalizedName = normalizeDisplayName(name, normalizedEmail);

	return {
		name: normalizedName,
		email: normalizedEmail,
		avatarUrl: normalizeUrlString(avatarUrl),
		initials: buildInitials(normalizedName, normalizedEmail),
		provider: provider?.trim() || null,
	};
}

async function buildNavigationPayload(env: Env): Promise<NavigationResponse> {
	const zones = await listZones(env);
	const allItems = [];

	for (const zone of zones) {
		const records = await listDnsRecords(env, zone.id);
		for (const record of records) {
			const item = normalizeRecord(record, zone.name);
			if (item) {
				allItems.push(item);
			}
		}
	}

	return {
		groups: groupItems(allItems),
		cachedAt: new Date().toISOString(),
		stale: false,
		source: 'live',
	};
}

async function listZones(env: Env): Promise<CloudflareZone[]> {
	const accountQuery = env.CF_ACCOUNT_ID
		? `account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}&`
		: '';
	const zones = await fetchPaginated<CloudflareZone>(env, `/zones?${accountQuery}per_page=50`);
	return zones.sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

async function listDnsRecords(env: Env, zoneId: string): Promise<CloudflareDnsRecord[]> {
	return fetchPaginated<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records?per_page=100`);
}

async function fetchPaginated<T>(env: Env, path: string): Promise<T[]> {
	const results: T[] = [];
	let page = 1;
	let totalPages = 1;
	const headers = buildCloudflareHeaders(env);

	do {
		const separator = path.includes('?') ? '&' : '?';
		const response = await fetch(`${CF_API_BASE}${path}${separator}page=${page}`, {
			headers,
		});

		if (!response.ok) {
			throw new Error(`Cloudflare API returned ${response.status}`);
		}

		const payload = (await response.json()) as CloudflareApiEnvelope<T[]>;
		if (!payload.success) {
			const message = payload.errors.map((entry) => entry.message).join('; ') || 'Cloudflare API request failed';
			throw new Error(message);
		}

		results.push(...payload.result);
		totalPages = payload.result_info?.total_pages ?? 1;
		page += 1;
	} while (page <= totalPages);

	return results;
}

function buildLogoutUrl(request: Request): string {
	return new URL('/cdn-cgi/access/logout', request.url).toString();
}

function readHeader(headers: Headers, name: string): string | null {
	return headers.get(name);
}

function copyRequestHeader(target: Headers, source: Headers, name: string) {
	const value = source.get(name);
	if (value) {
		target.set(name, value);
	}
}

function normalizeAccessTeamDomain(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}

	return trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function pickFirstString(...values: Array<unknown>): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}

	return null;
}

function normalizeDisplayName(value: string | undefined, email: string): string {
	const trimmed = value?.trim();
	if (trimmed) {
		return trimmed;
	}

	const [localPart = email] = email.split('@');
	const words = localPart
		.split(/[._-]+/g)
		.map((entry) => entry.trim())
		.filter(Boolean);

	if (!words.length) {
		return email;
	}

	return words
		.map((entry) => entry.charAt(0).toUpperCase() + entry.slice(1))
		.join(' ');
}

function buildInitials(name: string, email: string): string {
	const compactName = name.trim();
	if (compactName) {
		const tokens = compactName.split(/\s+/).filter(Boolean);
		if (tokens.length >= 2) {
			return `${takeInitial(tokens[0])}${takeInitial(tokens[1])}`.toUpperCase();
		}

		const letterOnly = Array.from(compactName).filter((char) => /\p{L}/u.test(char));
		if (letterOnly.length >= 2) {
			return `${letterOnly[0]}${letterOnly[1]}`.toUpperCase();
		}
		if (letterOnly.length === 1) {
			return letterOnly[0]!.toUpperCase();
		}

		const letters = Array.from(compactName).filter((char) => /\p{L}|\p{N}/u.test(char));
		if (letters.length >= 2) {
			return `${letters[0]}${letters[1]}`.toUpperCase();
		}
		if (letters.length === 1) {
			return letters[0]!.toUpperCase();
		}
	}

	return takeInitial(email).toUpperCase();
}

function takeInitial(value: string): string {
	return Array.from(value.trim())[0] ?? '?';
}

function normalizeUrlString(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}

	try {
		const url = new URL(value);
		return url.toString();
	} catch {
		return null;
	}
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname.endsWith('.localhost');
}

function buildCloudflareHeaders(env: Env): HeadersInit {
	if (env.CF_NAV_API_TOKEN) {
		return {
			authorization: `Bearer ${env.CF_NAV_API_TOKEN}`,
			accept: 'application/json',
		};
	}

	if (env.CF_AUTH_EMAIL && env.CF_GLOBAL_API_KEY) {
		return {
			'X-Auth-Email': env.CF_AUTH_EMAIL,
			'X-Auth-Key': env.CF_GLOBAL_API_KEY,
			accept: 'application/json',
		};
	}

	throw new Error('Missing Cloudflare credentials. Provide CF_NAV_API_TOKEN or CF_AUTH_EMAIL + CF_GLOBAL_API_KEY.');
}

function parseCacheTtl(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_SECONDS;
}

function isExpired(cachedAt: string, cacheTtlSeconds: number): boolean {
	const parsed = Date.parse(cachedAt);
	if (Number.isNaN(parsed)) {
		return true;
	}
	return Date.now() - parsed > cacheTtlSeconds * 1000;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}

export const __test__ = {
	buildCloudflareHeaders,
	normalizeAccessTeamDomain,
};
