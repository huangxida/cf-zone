import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { jwtVerifyMock, createRemoteJWKSetMock } = vi.hoisted(() => ({
	jwtVerifyMock: vi.fn(),
	createRemoteJWKSetMock: vi.fn((url: URL) => ({ url })),
}));

vi.mock('jose', () => ({
	jwtVerify: jwtVerifyMock,
	createRemoteJWKSet: createRemoteJWKSetMock,
}));

import worker, { __test__ } from '../worker';

const originalFetch = globalThis.fetch;

type TestEnv = Parameters<typeof worker.fetch>[1];
type KvStoredEntry = {
	value: string;
	metadata: unknown;
	expiration?: number;
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	vi.useRealTimers();
	jwtVerifyMock.mockReset();
	createRemoteJWKSetMock.mockClear();
});

beforeEach(() => {
	jwtVerifyMock.mockResolvedValue({
		payload: {
			email: 'alice.smith@example.com',
			name: 'Alice Smith',
		},
	});
});

describe('worker api', () => {
	it('returns zone-grouped navigation data and keeps non-featured records in the payload', async () => {
		const kv = createKvNamespaceStub();

		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(buildZonesResponse())
				.mockResolvedValueOnce(
					buildDnsResponse([
						{
							id: '1',
							name: 'panel.example.com',
							type: 'CNAME',
							content: 'origin.example.net',
							proxied: true,
							comment: '[nav/ops] Control',
						},
						{
							id: '2',
							name: '_acme-challenge.example.com',
							type: 'TXT',
							content: 'token-value',
							comment: '[nav] Verify',
						},
					]),
				),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites'),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				CF_NAV_API_TOKEN: 'runtime-token',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			groups: Array<{
				title: string;
				items: Array<{ title: string; hostname: string; recordType: string; featured: boolean }>;
			}>;
			banners: Array<{ code: string }>;
			lastUpdatedAt: string | null;
			source: string;
			stale: boolean;
		};

		expect(response.status).toBe(200);
		expect(payload.source).toBe('live');
		expect(payload.stale).toBe(false);
		expect(payload.banners).toEqual([]);
		expect(payload.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(payload.groups).toHaveLength(1);
		expect(payload.groups[0]?.title).toBe('example.com');
		expect(payload.groups[0]?.items).toHaveLength(2);
		expect(payload.groups[0]?.items[0]).toMatchObject({
			title: 'Control',
			hostname: 'panel.example.com',
			recordType: 'CNAME',
			featured: true,
		});
		expect(payload.groups[0]?.items[1]).toMatchObject({
			title: 'Verify',
			recordType: 'TXT',
			featured: false,
		});

		const cachedEntry = kv.entries.get('navigation:sites:v1');
		expect(cachedEntry).toBeDefined();
		expect(cachedEntry?.metadata).toMatchObject({
			lastUpdatedAt: payload.lastUpdatedAt,
		});
	});

	it('returns a warning banner when the live query succeeds but writing KV fails', async () => {
		const kv = createKvNamespaceStub();
		(kv.namespace as { put: typeof kv.namespace.put }).put = async () => {
			throw new Error('KV write failed');
		};

		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(buildZonesResponse())
				.mockResolvedValueOnce(
					buildDnsResponse([
						{
							id: '1',
							name: 'panel.example.com',
							type: 'CNAME',
							content: 'origin.example.net',
							proxied: true,
							comment: '[nav/ops] Control',
						},
					]),
				),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites?refresh=1'),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				CF_NAV_API_TOKEN: 'runtime-token',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			source: string;
			stale: boolean;
			banners: Array<{ code: string; level: string; message: string; detail: string | null }>;
		};

		expect(response.status).toBe(200);
		expect(payload.source).toBe('live');
		expect(payload.stale).toBe(false);
		expect(payload.banners).toEqual([
			expect.objectContaining({
				code: 'cache-write-failed',
				level: 'warning',
			}),
		]);
	});

	it('serves the KV cache by default and only changes the timestamp after a real refresh', async () => {
		vi.useFakeTimers();
		const kv = createKvNamespaceStub();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		fetchMock.mockResolvedValueOnce(buildZonesResponse()).mockResolvedValueOnce(
			buildDnsResponse([
				{
					id: '1',
					name: 'panel.example.com',
					type: 'CNAME',
					content: 'origin.example.net',
					proxied: true,
					comment: '[nav/ops] Control',
				},
			]),
		);

		const testEnv = createWorkerEnv({
			NAV_CACHE_KV: kv.namespace,
			CF_NAV_API_TOKEN: 'runtime-token',
		});

		vi.setSystemTime(new Date('2026-03-28T00:00:00.000Z'));
		const firstCtx = createExecutionContext();
		const firstResponse = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites'),
			testEnv,
			firstCtx,
		);
		await waitOnExecutionContext(firstCtx);
		const firstPayload = (await firstResponse.json()) as {
			groups: Array<{ items: Array<{ title: string }> }>;
			lastUpdatedAt: string | null;
			source: string;
			stale: boolean;
		};

		expect(firstPayload.source).toBe('live');
		expect(firstPayload.stale).toBe(false);
		expect(firstPayload.lastUpdatedAt).toBe('2026-03-28T00:00:00.000Z');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		vi.setSystemTime(new Date('2026-03-28T06:00:00.000Z'));
		const cachedCtx = createExecutionContext();
		const cachedResponse = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites'),
			testEnv,
			cachedCtx,
		);
		await waitOnExecutionContext(cachedCtx);
		const cachedPayload = (await cachedResponse.json()) as {
			groups: Array<{ items: Array<{ title: string }> }>;
			lastUpdatedAt: string | null;
			source: string;
			stale: boolean;
		};

		expect(cachedPayload.source).toBe('cache');
		expect(cachedPayload.stale).toBe(false);
		expect(cachedPayload.lastUpdatedAt).toBe('2026-03-28T00:00:00.000Z');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		fetchMock.mockResolvedValueOnce(buildZonesResponse()).mockResolvedValueOnce(
			buildDnsResponse([
				{
					id: '1',
					name: 'panel.example.com',
					type: 'CNAME',
					content: 'origin-v2.example.net',
					proxied: true,
					comment: '[nav/ops] Admin',
				},
			]),
		);

		vi.setSystemTime(new Date('2026-03-28T12:00:00.000Z'));
		const refreshCtx = createExecutionContext();
		const refreshResponse = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites?refresh=1'),
			testEnv,
			refreshCtx,
		);
		await waitOnExecutionContext(refreshCtx);
		const refreshPayload = (await refreshResponse.json()) as {
			groups: Array<{ items: Array<{ title: string }> }>;
			lastUpdatedAt: string | null;
			source: string;
			stale: boolean;
		};

		expect(refreshPayload.source).toBe('live');
		expect(refreshPayload.stale).toBe(false);
		expect(refreshPayload.lastUpdatedAt).toBe('2026-03-28T12:00:00.000Z');
		expect(refreshPayload.groups[0]?.items[0]?.title).toBe('Admin');
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it('bypasses KV on force refresh and returns a 503 when the live query fails', async () => {
		vi.useFakeTimers();
		const kv = createKvNamespaceStub();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		fetchMock.mockResolvedValueOnce(buildZonesResponse()).mockResolvedValueOnce(
			buildDnsResponse([
				{
					id: '1',
					name: 'panel.example.com',
					type: 'CNAME',
					content: 'origin.example.net',
					proxied: true,
					comment: '[nav/ops] Control',
				},
			]),
		);

		const testEnv = createWorkerEnv({
			NAV_CACHE_KV: kv.namespace,
			CF_NAV_API_TOKEN: 'runtime-token',
		});

		vi.setSystemTime(new Date('2026-03-28T00:00:00.000Z'));
		const warmupCtx = createExecutionContext();
		await worker.fetch(createAuthenticatedRequest('https://cf-zone.test/api/sites'), testEnv, warmupCtx);
		await waitOnExecutionContext(warmupCtx);
		(kv.namespace as { getWithMetadata: typeof kv.namespace.getWithMetadata }).getWithMetadata = async () => {
			throw new Error('force refresh should not read KV');
		};

		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					success: false,
					errors: [{ code: 10000, message: 'Authentication error' }],
					result: [],
				},
				{ status: 403 },
			),
		);

		vi.setSystemTime(new Date('2026-03-28T12:00:00.000Z'));
		const refreshCtx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites?refresh=1'),
			testEnv,
			refreshCtx,
		);
		await waitOnExecutionContext(refreshCtx);
		const payload = (await response.json()) as {
			error: string;
			banners: Array<{ code: string; level: string; message: string; detail: string | null }>;
		};

		expect(response.status).toBe(503);
		expect(payload.error).toContain('Cloudflare');
		expect(payload.banners).toEqual([
			expect.objectContaining({
				code: 'query-failed',
				level: 'error',
			}),
		]);
	});

	it('returns a 503 if Cloudflare API fails before a cache exists', async () => {
		const kv = createKvNamespaceStub();

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(
				Response.json(
					{
						success: false,
						errors: [{ code: 10000, message: 'Authentication error' }],
						result: [],
					},
					{ status: 403 },
				),
			),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites?refresh=1'),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				CF_NAV_API_TOKEN: 'runtime-token',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			error: string;
			banners: Array<{ code: string; level: string }>;
		};

		expect(response.status).toBe(503);
		expect(payload.error).toContain('Cloudflare');
		expect(payload.banners).toEqual([
			expect.objectContaining({
				code: 'query-failed',
				level: 'error',
			}),
		]);
	});

	it('rejects non-loopback api requests that do not carry an Access JWT', async () => {
		const kv = createKvNamespaceStub();

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://cf-zone.test/api/sites'),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				CF_NAV_API_TOKEN: 'runtime-token',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			error: string;
			banners: Array<{ code: string; level: string }>;
		};

		expect(response.status).toBe(401);
		expect(payload.error).toContain('Cloudflare Access');
		expect(payload.banners).toEqual([
			expect.objectContaining({
				code: 'access-token-missing',
				level: 'error',
			}),
		]);
	});

	it('rejects non-loopback api requests with an invalid Access JWT', async () => {
		const kv = createKvNamespaceStub();
		jwtVerifyMock.mockRejectedValueOnce(new Error('signature verification failed'));

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://cf-zone.test/api/sites'),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				CF_NAV_API_TOKEN: 'runtime-token',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			error: string;
			banners: Array<{ code: string; level: string }>;
		};

		expect(response.status).toBe(403);
		expect(payload.error).toContain('Cloudflare Access');
		expect(payload.banners).toEqual([
			expect.objectContaining({
				code: 'access-token-invalid',
				level: 'error',
			}),
		]);
	});

	it('exposes environment variables and bindings via the generated Env type', () => {
		expect(env.CF_ACCOUNT_ID).toBeTypeOf('string');
		expect(env.NAV_CACHE_KV).toBeDefined();
	});

	it('builds global api key headers when token auth is absent', () => {
		expect(
			__test__.buildCloudflareHeaders(
				createWorkerEnv({
					CF_AUTH_EMAIL: 'user@example.com',
					CF_GLOBAL_API_KEY: 'global-key',
				}),
			),
		).toEqual({
			'X-Auth-Email': 'user@example.com',
			'X-Auth-Key': 'global-key',
			accept: 'application/json',
		});
	});

	it('returns the current Access user profile when the identity endpoint succeeds', async () => {
		const kv = createKvNamespaceStub();

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(
				Response.json({
					name: 'Jane Doe',
					email: 'Jane.Doe@example.com',
					picture: 'https://cdn.example.com/avatar.jpg',
					idp: {
						type: 'google',
					},
				}),
			),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://nav.example.com/api/me', {
				headers: {
					Cookie: 'CF_Authorization=test-token',
				},
			}),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			authenticated: boolean;
			source: string;
			logoutUrl: string | null;
			user: {
				name: string;
				email: string;
				avatarUrl: string | null;
				initials: string;
				provider: string | null;
			} | null;
		};

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			authenticated: true,
			source: 'access',
			logoutUrl: 'https://nav.example.com/cdn-cgi/access/logout',
			user: {
				name: 'Jane Doe',
				email: 'jane.doe@example.com',
				avatarUrl: 'https://cdn.example.com/avatar.jpg',
				initials: 'JD',
				provider: 'google',
			},
		});
	});

	it('falls back to Access email headers when the identity endpoint is not configured', async () => {
		const kv = createKvNamespaceStub();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 })));

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			createAuthenticatedRequest('https://nav.example.com/api/me', {
				headers: {
					'CF-Access-Authenticated-User-Email': 'alice.smith@example.com',
				},
			}),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			authenticated: boolean;
			source: string;
			user: {
				name: string;
				email: string;
				initials: string;
			} | null;
		};

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			authenticated: true,
			source: 'access',
			user: {
				name: 'Alice Smith',
				email: 'alice.smith@example.com',
				initials: 'AS',
			},
		});
	});

	it('uses a dedicated local preview identity on localhost', async () => {
		const kv = createKvNamespaceStub();

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('http://127.0.0.1:4173/api/me'),
			createWorkerEnv({
				NAV_CACHE_KV: kv.namespace,
				MOCK_USER_EMAIL: 'preview.user@example.com',
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			authenticated: boolean;
			source: string;
			user: {
				name: string;
				email: string;
				provider: string | null;
			} | null;
		};

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			authenticated: true,
			source: 'mock',
			user: {
				name: 'Preview User',
				email: 'preview.user@example.com',
				provider: 'local-preview',
			},
		});
	});
});

function createWorkerEnv(overrides: Partial<TestEnv> = {}): TestEnv {
	return {
		ASSETS: {
			fetch: vi.fn().mockResolvedValue(new Response('assets')),
		} as Fetcher,
		NAV_CACHE_KV: createKvNamespaceStub().namespace,
		CF_ACCOUNT_ID: 'test-account-id',
		CACHE_TTL_SECONDS: '2592000',
		ENABLE_DEMO_MODE: 'false',
		CF_ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
		CF_ACCESS_AUD: 'test-access-aud',
		...overrides,
	} as TestEnv;
}

function createAuthenticatedRequest(input: string, init?: RequestInit) {
	const headers = new Headers(init?.headers);
	headers.set('cf-access-jwt-assertion', 'test-access-jwt');

	return new Request(input, {
		...init,
		headers,
	});
}

function createKvNamespaceStub() {
	const entries = new Map<string, KvStoredEntry>();

	const namespace = {
		async getWithMetadata(key: string, typeOrOptions?: { type?: string } | string) {
			const entry = readKvEntry(entries, key);
			if (!entry) {
				return {
					value: null,
					metadata: null,
					cacheStatus: null,
				};
			}

			const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
			return {
				value: type === 'json' ? JSON.parse(entry.value) : entry.value,
				metadata: entry.metadata ?? null,
				cacheStatus: null,
			};
		},
		async put(
			key: string,
			value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
			options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
		) {
			const expiration =
				typeof options?.expiration === 'number'
					? options.expiration
					: typeof options?.expirationTtl === 'number'
						? Math.floor(Date.now() / 1000) + options.expirationTtl
						: undefined;

			entries.set(key, {
				value: serializeKvValue(value),
				metadata: options?.metadata ?? null,
				expiration,
			});
		},
		async delete(key: string) {
			entries.delete(key);
		},
	} as unknown as KVNamespace;

	return {
		namespace,
		entries,
	};
}

function readKvEntry(entries: Map<string, KvStoredEntry>, key: string): KvStoredEntry | null {
	const entry = entries.get(key);
	if (!entry) {
		return null;
	}

	if (typeof entry.expiration === 'number' && entry.expiration <= Math.floor(Date.now() / 1000)) {
		entries.delete(key);
		return null;
	}

	return entry;
}

function serializeKvValue(value: string | ArrayBuffer | ArrayBufferView | ReadableStream): string {
	if (typeof value === 'string') {
		return value;
	}

	if (value instanceof ArrayBuffer) {
		return new TextDecoder().decode(value);
	}

	if (ArrayBuffer.isView(value)) {
		return new TextDecoder().decode(value);
	}

	throw new Error('Unsupported KV test value');
}

function buildZonesResponse() {
	return Response.json({
		success: true,
		errors: [],
		result: [{ id: 'zone-1', name: 'example.com' }],
		result_info: { page: 1, per_page: 50, total_pages: 1, count: 1, total_count: 1 },
	});
}

function buildDnsResponse(records: Array<Record<string, unknown>>) {
	return Response.json({
		success: true,
		errors: [],
		result: records,
		result_info: { page: 1, per_page: 100, total_pages: 1, count: records.length, total_count: records.length },
	});
}
