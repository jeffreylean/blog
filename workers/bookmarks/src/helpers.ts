export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export function isValidUrl(str: string): boolean {
	try {
		const url = new URL(str);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

const TAG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TAG_MAX_LENGTH = 50;

export function validateTagName(name: string): boolean {
	return name.length <= TAG_MAX_LENGTH && TAG_PATTERN.test(name);
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
	try {
		return await request.json<T>();
	} catch {
		throw new HttpError(400, 'Invalid JSON');
	}
}

export async function syncBookmarkTags(db: D1Database, bookmarkId: number, tagNames: string[]): Promise<void> {
	for (const name of tagNames) {
		if (!validateTagName(name)) {
			throw new HttpError(422, `Invalid tag name: ${name}`);
		}
	}

	await db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(bookmarkId).run();

	for (const tagName of tagNames) {
		let tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: number }>();
		if (!tag) {
			const result = await db.prepare('INSERT INTO tags (name, is_approved) VALUES (?, 0)').bind(tagName).run();
			tag = { id: result.meta.last_row_id as number };
		}
		await db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)').bind(bookmarkId, tag.id).run();
	}
}
