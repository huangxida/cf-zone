import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('worker api', () => {
	it('returns navigation data grouped from Cloudflare API responses', async () => {
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
							{ id: '1', name: 'panel.example.com', type: 'CNAME', proxied: true, comment: '[nav/运维] 控制台' },
							{ id: '2', name: '_acme-challenge.example.com', type: 'TXT', comment: '[nav] 验证' },
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
			groups: Array<{ title: string; items: Array<{ title: string; hostname: string }> }>;
			source: string;
			stale: boolean;
		};

		expect(response.status).toBe(200);
		expect(payload.source).toBe('live');
		expect(payload.stale).toBe(false);
		expect(payload.groups).toHaveLength(1);
		expect(payload.groups[0]?.title).toBe('运维');
		expect(payload.groups[0]?.items[0]).toMatchObject({
			title: '控制台',
			hostname: 'panel.example.com',
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
});
