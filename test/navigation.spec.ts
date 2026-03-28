import { describe, expect, it } from 'vitest';
import {
	DEFAULT_GROUP_LABEL,
	groupItems,
	isEligibleRecord,
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

describe('record filtering', () => {
	it('accepts supported DNS records with nav comments', () => {
		expect(
			isEligibleRecord({
				id: '1',
				name: 'panel.example.com',
				type: 'CNAME',
				comment: '[nav] 面板',
			}),
		).toBe(true);
	});

	it('rejects unsupported record types or system labels', () => {
		expect(
			isEligibleRecord({
				id: '2',
				name: '_acme-challenge.example.com',
				type: 'TXT',
				comment: '[nav] TXT',
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
					proxied: true,
					comment: '[nav]',
				},
				'example.com',
			),
		).toMatchObject({
			title: 'example.com',
			url: 'https://example.com',
			proxied: true,
		});
	});

	it('groups items alphabetically but keeps apex records first', () => {
		const groups = groupItems([
			{
				group: '运维',
				title: '面板',
				hostname: 'panel.example.com',
				url: 'https://panel.example.com',
				recordType: 'CNAME',
				proxied: false,
				comment: '[nav/运维] 面板',
				zoneName: 'example.com',
			},
			{
				group: '运维',
				title: '站点根域',
				hostname: 'example.com',
				url: 'https://example.com',
				recordType: 'A',
				proxied: true,
				comment: '[nav/运维] 站点根域',
				zoneName: 'example.com',
			},
		]);

		expect(groups[0]?.title).toBe('运维');
		expect(groups[0]?.items[0]?.hostname).toBe('example.com');
	});
});
