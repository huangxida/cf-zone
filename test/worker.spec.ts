import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { __test__ } from '../worker';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('worker api', () => {
	it('returns zone-grouped navigation data and keeps non-featured records in the payload', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						success: true,
						errors: [],
						result: [{ id: 'zone-1', name: 'example.com' }],
						result_info: { page: 1, per_page: 50, total_pages: 1, count: 1, total_count: 1 },
					}),
				)
				.mockResolvedValueOnce(
					Response.json({
						success: true,
						errors: [],
						result: [
							{
								id: '1',
								name: 'panel.example.com',
								type: 'CNAME',
								content: 'origin.example.net',
								proxied: true,
								comment: '[nav/运维] 控制台',
							},
							{
								id: '2',
								name: '_acme-challenge.example.com',
								type: 'TXT',
								content: 'token-value',
								comment: '[nav] 验证',
							},
						],
						result_info: { page: 1, per_page: 100, total_pages: 1, count: 2, total_count: 2 },
					}),
				),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://cf-zone.test/api/sites'),
			{
				ASSETS: {
					fetch: vi.fn().mockResolvedValue(new Response('assets')),
				},
				CF_ACCOUNT_ID: 'test-account-id',
				CACHE_TTL_SECONDS: '300',
				CF_NAV_API_TOKEN: 'runtime-token',
			},
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as {
			groups: Array<{
				title: string;
				items: Array<{ title: string; hostname: string; recordType: string; featured: boolean }>;
			}>;
			source: string;
			stale: boolean;
		};

		expect(response.status).toBe(200);
		expect(payload.source).toBe('live');
		expect(payload.stale).toBe(false);
		expect(payload.groups).toHaveLength(1);
		expect(payload.groups[0]?.title).toBe('example.com');
		expect(payload.groups[0]?.items).toHaveLength(2);
		expect(payload.groups[0]?.items[0]).toMatchObject({
			title: '控制台',
			hostname: 'panel.example.com',
			recordType: 'CNAME',
			featured: true,
		});
		expect(payload.groups[0]?.items[1]).toMatchObject({
			title: '验证',
			recordType: 'TXT',
			featured: false,
		});
	});

	it('returns a 503 if Cloudflare API fails before a cache exists', async () => {
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
			new Request('https://cf-zone.test/api/sites?refresh=1'),
			{
				ASSETS: {
					fetch: vi.fn().mockResolvedValue(new Response('assets')),
				},
				CF_ACCOUNT_ID: 'test-account-id',
				CACHE_TTL_SECONDS: '300',
				CF_NAV_API_TOKEN: 'runtime-token',
			},
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const payload = (await response.json()) as { error: string };

		expect(response.status).toBe(503);
		expect(payload.error).toContain('无法从 Cloudflare 读取导航数据');
	});

	it('exposes environment variables via the generated Env type', () => {
		expect(env.CF_ACCOUNT_ID).toBeTypeOf('string');
	});

	it('builds global api key headers when token auth is absent', () => {
		expect(
			__test__.buildCloudflareHeaders({
				ASSETS: {} as Fetcher,
				CF_ACCOUNT_ID: '',
				CACHE_TTL_SECONDS: '300',
				CF_AUTH_EMAIL: 'user@example.com',
				CF_GLOBAL_API_KEY: 'global-key',
			}),
		).toEqual({
			'X-Auth-Email': 'user@example.com',
			'X-Auth-Key': 'global-key',
			accept: 'application/json',
		});
	});

	it('returns the current Access user profile when the identity endpoint succeeds', async () => {
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
			new Request('https://nav.example.com/api/me', {
				headers: {
					Cookie: 'CF_Authorization=test-token',
				},
			}),
			{
				ASSETS: {
					fetch: vi.fn().mockResolvedValue(new Response('assets')),
				},
				CF_ACCOUNT_ID: 'test-account-id',
				CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
			},
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
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('https://nav.example.com/api/me', {
				headers: {
					'CF-Access-Authenticated-User-Email': 'alice.smith@example.com',
				},
			}),
			{
				ASSETS: {
					fetch: vi.fn().mockResolvedValue(new Response('assets')),
				},
				CF_ACCOUNT_ID: 'test-account-id',
			},
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
			source: 'header',
			user: {
				name: 'Alice Smith',
				email: 'alice.smith@example.com',
				initials: 'AS',
			},
		});
	});

	it('uses the local Cloudflare auth email as a preview identity on localhost', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('http://127.0.0.1:4173/api/me'),
			{
				ASSETS: {
					fetch: vi.fn().mockResolvedValue(new Response('assets')),
				},
				CF_ACCOUNT_ID: 'test-account-id',
				CF_AUTH_EMAIL: 'preview.user@example.com',
			},
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
