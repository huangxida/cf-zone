import {
	groupItems,
	normalizeRecord,
	type CloudflareApiEnvelope,
	type CloudflareDnsRecord,
	type CloudflareZone,
	type NavigationResponse,
} from '../shared/navigation';

type Env = {
	ASSETS: Fetcher;
	CF_ACCOUNT_ID: string;
	CACHE_TTL_SECONDS?: string;
	CF_NAV_API_TOKEN: string;
};

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const CACHE_URL = 'https://cf-zone.internal/api/sites';
const DEFAULT_CACHE_TTL_SECONDS = 300;

type CachedPayload = NavigationResponse;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/healthz') {
			return Response.json({ ok: true, now: new Date().toISOString() });
		}

		if (url.pathname === '/api/sites') {
			return handleSitesRequest(request, env, ctx);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function handleSitesRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
	const zones = await fetchPaginated<CloudflareZone>(env, `/zones?account.id=${encodeURIComponent(env.CF_ACCOUNT_ID)}&per_page=50`);
	return zones.sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

async function listDnsRecords(env: Env, zoneId: string): Promise<CloudflareDnsRecord[]> {
	return fetchPaginated<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records?per_page=100`);
}

async function fetchPaginated<T>(env: Env, path: string): Promise<T[]> {
	const results: T[] = [];
	let page = 1;
	let totalPages = 1;

	do {
		const separator = path.includes('?') ? '&' : '?';
		const response = await fetch(`${CF_API_BASE}${path}${separator}page=${page}`, {
			headers: {
				authorization: `Bearer ${env.CF_NAV_API_TOKEN}`,
				accept: 'application/json',
			},
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
