export const SUPPORTED_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'HTTPS']);
export const DEFAULT_GROUP_LABEL = '常用';
export const COMMENT_PATTERN = /^\[nav(?:\/(?<group>[^[\]]+))?\]\s*(?<title>.*)$/i;

export type NavigationItem = {
	group: string;
	title: string;
	hostname: string;
	url: string;
	recordType: string;
	proxied: boolean;
	comment: string;
	zoneName: string;
};

export type NavigationGroup = {
	id: string;
	title: string;
	items: NavigationItem[];
};

export type NavigationResponse = {
	groups: NavigationGroup[];
	cachedAt: string;
	stale: boolean;
	source: 'live' | 'cache';
};

export type CloudflareZone = {
	id: string;
	name: string;
};

export type CloudflareDnsRecord = {
	id: string;
	name: string;
	type: string;
	proxied?: boolean | null;
	comment?: string | null;
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

export function isEligibleRecord(record: CloudflareDnsRecord): boolean {
	if (!SUPPORTED_RECORD_TYPES.has(record.type)) {
		return false;
	}

	if (record.name.startsWith('*.') || record.name.startsWith('_')) {
		return false;
	}

	return parseNavigationComment(record.comment) !== null;
}

export function normalizeRecord(record: CloudflareDnsRecord, zoneName: string): NavigationItem | null {
	const parsed = parseNavigationComment(record.comment);
	if (!parsed || !isEligibleRecord(record)) {
		return null;
	}

	const hostname = record.name === zoneName ? zoneName : record.name;
	const title = parsed.title || hostname;

	return {
		group: parsed.group,
		title,
		hostname,
		url: `https://${hostname}`,
		recordType: record.type,
		proxied: Boolean(record.proxied),
		comment: record.comment?.trim() || '',
		zoneName,
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
		.map(([title, groupItems]) => ({
			id: title.toLowerCase().replace(/\s+/g, '-'),
			title,
			items: groupItems.sort((left, right) => {
				const leftIsApex = left.hostname === left.zoneName;
				const rightIsApex = right.hostname === right.zoneName;
				if (leftIsApex !== rightIsApex) {
					return leftIsApex ? -1 : 1;
				}
				return left.title.localeCompare(right.title, 'zh-CN');
			}),
		}));
}
