import { describe, expect, it } from 'vitest';
import {
	DEFAULT_GROUP_LABEL,
	buildNavigationUrl,
	groupItems,
	isFeaturedRecord,
	normalizeRecord,
	parseNavigationComment,
} from '../shared/navigation';

describe('navigation parsing', () => {
	it('parses default groups from comments', () => {
		expect(parseNavigationComment('[nav] 控制台')).toEqual({
			group: DEFAULT_GROUP_LABEL,
			title: '控制台',
		});
	});

	it('parses explicit groups from comments', () => {
		expect(parseNavigationComment('[nav/运维] Dashboard')).toEqual({
			group: '运维',
			title: 'Dashboard',
		});
	});

	it('ignores comments without navigation marker', () => {
		expect(parseNavigationComment('plain text')).toBeNull();
	});
});

describe('featured rules', () => {
	it('marks supported website records with nav comments as featured', () => {
		expect(
			isFeaturedRecord({
				id: '1',
				name: 'panel.example.com',
				type: 'CNAME',
				comment: '[nav] 面板',
			}),
		).toBe(true);
	});

	it('does not feature system labels or unsupported record types', () => {
		expect(
			isFeaturedRecord({
				id: '2',
				name: '_acme-challenge.example.com',
				type: 'TXT',
				comment: '[nav] TXT',
			}),
		).toBe(false);
	});

	it('does not feature sub-prefixed hostnames even if they have nav comments', () => {
		expect(
			isFeaturedRecord({
				id: '3',
				name: 'sub-los1.imjj.cc',
				type: 'A',
				comment: '[nav/sub] los1 subscription',
			}),
		).toBe(false);
	});
});

describe('normalization and grouping', () => {
	it('normalizes apex records and falls back to hostname title', () => {
		expect(
			normalizeRecord(
				{
					id: '3',
					name: 'example.com',
					type: 'A',
					content: '203.0.113.10',
					proxied: true,
					comment: '[nav]',
				},
				'example.com',
			),
		).toMatchObject({
			group: 'example.com',
			title: 'example.com',
			url: 'https://example.com',
			value: '203.0.113.10',
			featured: true,
			proxied: true,
		});
	});

	it('keeps all DNS records in the zone payload even if they are not featured', () => {
		expect(
			normalizeRecord(
				{
					id: '4',
					name: '_acme-challenge.example.com',
					type: 'TXT',
					content: 'token-value',
					comment: '[nav] 验证',
				},
				'example.com',
			),
		).toMatchObject({
			group: 'example.com',
			title: '验证',
			url: null,
			value: 'token-value',
			featured: false,
		});
	});

	it('adds configured path suffixes for mapped hosts', () => {
		expect(buildNavigationUrl('dash-los1.imjj.cc')).toBe('https://dash-los1.imjj.cc/mKJauEunDk');
		expect(buildNavigationUrl('dash-los2.imjj.cc')).toBe('https://dash-los2.imjj.cc/HUiDFyB6UM');
		expect(buildNavigationUrl('dash-los3.imjj.cc')).toBe('https://dash-los3.imjj.cc/b9dd611bac/');
		expect(buildNavigationUrl('dash-ca1.imjj.cc')).toBe('https://dash-ca1.imjj.cc/MiAd3DmRn8');
		expect(buildNavigationUrl('dash-s2a.imjj.cc')).toBe('https://dash-s2a.imjj.cc/admin/dashboard');
	});

	it('normalizes hostnames before applying mapped path suffixes', () => {
		expect(buildNavigationUrl('DASH-LOS3.IMJJ.CC.')).toBe('https://dash-los3.imjj.cc/b9dd611bac/');
	});

	it('groups items by managed zone and keeps featured entries first', () => {
		const groups = groupItems([
			{
				group: 'example.com',
				title: '验证 TXT',
				hostname: '_acme-challenge.example.com',
				url: null,
				recordType: 'TXT',
				proxied: false,
				comment: '[nav] 验证',
				zoneName: 'example.com',
				value: 'token-value',
				featured: false,
			},
			{
				group: 'example.com',
				title: '站点根域',
				hostname: 'example.com',
				url: 'https://example.com',
				recordType: 'A',
				proxied: true,
				comment: '[nav/运维] 站点根域',
				zoneName: 'example.com',
				value: '203.0.113.10',
				featured: true,
			},
		]);

		expect(groups[0]?.title).toBe('example.com');
		expect(groups[0]?.items[0]?.hostname).toBe('example.com');
		expect(groups[0]?.items[1]?.recordType).toBe('TXT');
	});
});
