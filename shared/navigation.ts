export const DEFAULT_GROUP_LABEL = '常用';
export const COMMENT_PATTERN = /^\[nav(?:\/(?<group>[^[\]]+))?\]\s*(?<title>.*)$/i;
export const FEATURED_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'HTTPS']);

const HOST_PATHS: Record<string, string> = {
	'dash-los1.imjj.cc': '/mKJauEunDk',
	'dash-los2.imjj.cc': '/HUiDFyB6UM',
	'dash-los3.imjj.cc': '/b9dd611bac/',
	'dash-ca1.imjj.cc': '/MiAd3DmRn8',
	'dash-s2a.imjj.cc': '/admin/dashboard',
};

const FEATURED_EXCLUDED_HOSTNAME_PREFIXES = ['sub-'];

export type NavigationItem = {
	group: string;
	title: string;
	hostname: string;
	url: string | null;
	recordType: string;
	proxied: boolean;
	comment: string;
	zoneName: string;
	value: string;
	featured: boolean;
};

export type NavigationGroup = {
	id: string;
	title: string;
	items: NavigationItem[];
};

export type NavigationBannerLevel = 'info' | 'warning' | 'error';

export type NavigationBanner = {
	code: string;
	level: NavigationBannerLevel;
	message: string;
	detail?: string | null;
};

export type NavigationResponse = {
	groups: NavigationGroup[];
	lastUpdatedAt: string | null;
	stale: boolean;
	source: 'live' | 'cache';
	banners: NavigationBanner[];
};

export type NavigationErrorResponse = {
	error: string;
	detail?: string;
	banners?: NavigationBanner[];
};

export type CloudflareZone = {
	id: string;
	name: string;
	account?: {
		id?: string;
		name?: string;
	};
};

export type CloudflareDnsRecord = {
	id: string;
	name: string;
	type: string;
	content?: string | null;
	proxied?: boolean | null;
	comment?: string | null;
	priority?: number | null;
	ttl?: number | null;
	data?: Record<string, unknown> | null;
};

export type CloudflareApiEnvelope<T> = {
	success: boolean;
	errors: Array<{ code: number; message: string }>;
	result: T;
	result_info?: {
		page: number;
		per_page: number;
		total_pages: number;
		count: number;
		total_count: number;
	};
};

export type ParsedComment = {
	group: string;
	title: string;
};

export function parseNavigationComment(comment: string | null | undefined): ParsedComment | null {
	if (!comment) {
		return null;
	}

	const match = comment.trim().match(COMMENT_PATTERN);
	if (!match) {
		return null;
	}

	const group = (match.groups?.group || DEFAULT_GROUP_LABEL).trim() || DEFAULT_GROUP_LABEL;
	const title = (match.groups?.title || '').trim();
	return { group, title };
}

export function isFeaturedRecord(record: CloudflareDnsRecord): boolean {
	if (!FEATURED_RECORD_TYPES.has(record.type)) {
		return false;
	}

	if (record.name.startsWith('*.') || record.name.startsWith('_')) {
		return false;
	}

	if (FEATURED_EXCLUDED_HOSTNAME_PREFIXES.some((prefix) => record.name.startsWith(prefix))) {
		return false;
	}

	return parseNavigationComment(record.comment) !== null;
}

export function buildNavigationUrl(hostname: string): string {
	const normalizedHostname = hostname.trim().toLowerCase().replace(/\.+$/, '');
	const pathname = HOST_PATHS[normalizedHostname] ?? '';
	return `https://${normalizedHostname}${pathname}`;
}

export function normalizeRecord(record: CloudflareDnsRecord, zoneName: string): NavigationItem {
	const parsed = parseNavigationComment(record.comment);
	const hostname = record.name === zoneName ? zoneName : record.name;
	const title = parsed?.title || hostname;

	return {
		group: zoneName,
		title,
		hostname,
		url: buildRecordUrl(record, hostname),
		recordType: record.type,
		proxied: Boolean(record.proxied),
		comment: record.comment?.trim() || '',
		zoneName,
		value: formatRecordValue(record),
		featured: isFeaturedRecord(record),
	};
}

export function groupItems(items: NavigationItem[]): NavigationGroup[] {
	const grouped = new Map<string, NavigationItem[]>();

	for (const item of items) {
		const current = grouped.get(item.group) ?? [];
		current.push(item);
		grouped.set(item.group, current);
	}

	return [...grouped.entries()]
		.sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
		.map(([title, zoneItems]) => ({
			id: title.toLowerCase().replace(/\s+/g, '-'),
			title,
			items: zoneItems.sort((left, right) => {
				if (left.featured !== right.featured) {
					return left.featured ? -1 : 1;
				}

				const leftIsApex = left.hostname === left.zoneName;
				const rightIsApex = right.hostname === right.zoneName;
				if (leftIsApex !== rightIsApex) {
					return leftIsApex ? -1 : 1;
				}

				const typeComparison = left.recordType.localeCompare(right.recordType, 'en');
				if (typeComparison !== 0) {
					return typeComparison;
				}

				return left.title.localeCompare(right.title, 'zh-CN');
			}),
		}));
}

function buildRecordUrl(record: CloudflareDnsRecord, hostname: string): string | null {
	if (!FEATURED_RECORD_TYPES.has(record.type)) {
		return null;
	}

	if (hostname.startsWith('*.') || hostname.startsWith('_')) {
		return null;
	}

	return buildNavigationUrl(hostname);
}

function formatRecordValue(record: CloudflareDnsRecord): string {
	if (record.priority !== undefined && record.priority !== null && record.content) {
		return `${record.priority} ${record.content}`;
	}

	if (record.content && record.content.trim()) {
		return record.content.trim();
	}

	if (record.data && Object.keys(record.data).length > 0) {
		return JSON.stringify(record.data);
	}

	if (record.ttl !== undefined && record.ttl !== null) {
		return `TTL ${record.ttl}`;
	}

	return '无附加值';
}
