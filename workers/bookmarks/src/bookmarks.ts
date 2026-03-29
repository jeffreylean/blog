import type { JsonFn, BookmarkRow, CreateBookmarkBody, UpdateBookmarkBody, BatchUpdateBody } from './types';
import { isValidUrl, parseJsonBody, syncBookmarkTags } from './helpers';

export async function createBookmark(request: Request, db: D1Database, json: JsonFn): Promise<Response> {
	const body = await parseJsonBody<CreateBookmarkBody>(request);

	if (!body.url || !isValidUrl(body.url)) {
		return json({ error: 'Invalid URL' }, 422);
	}

	const existing = await db.prepare('SELECT id FROM bookmarks WHERE url = ?').bind(body.url).first();
	if (existing) {
		return json({ error: 'Bookmark already exists' }, 409);
	}

	// Auto-fetch title
	let title = body.url;
	try {
		const resp = await fetch(body.url, {
			headers: { 'User-Agent': 'BookmarkBot/1.0' },
			redirect: 'follow',
		});
		if (resp.ok) {
			const html = await resp.text();
			const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
			if (match) {
				title = match[1].trim();
			}
		}
	} catch {
		// fallback to URL as title
	}

	const now = new Date().toISOString();
	const result = await db
		.prepare('INSERT INTO bookmarks (url, title, is_read, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
		.bind(body.url, title, now, now)
		.run();

	return json({ id: result.meta.last_row_id, url: body.url, title, created_at: now }, 201);
}

export async function listBookmarks(url: URL, db: D1Database, json: JsonFn): Promise<Response> {
	const tag = url.searchParams.get('tag');
	const search = url.searchParams.get('search');
	const untagged = url.searchParams.get('untagged');
	const unread = url.searchParams.get('unread');
	const limit = parseInt(url.searchParams.get('limit') || '50', 10);
	const offset = parseInt(url.searchParams.get('offset') || '0', 10);

	let countQuery = 'SELECT COUNT(DISTINCT b.id) as total FROM bookmarks b';
	let query = 'SELECT DISTINCT b.* FROM bookmarks b';
	const conditions: string[] = [];
	const binds: (string | number)[] = [];

	if (tag) {
		query += ' JOIN bookmark_tags bt ON b.id = bt.bookmark_id JOIN tags t ON bt.tag_id = t.id';
		countQuery += ' JOIN bookmark_tags bt ON b.id = bt.bookmark_id JOIN tags t ON bt.tag_id = t.id';
		conditions.push('t.name = ?');
		binds.push(tag);
	}

	if (untagged === 'true') {
		conditions.push('b.id NOT IN (SELECT bookmark_id FROM bookmark_tags)');
	}

	if (unread === 'true') {
		conditions.push('b.is_read = 0');
	}

	if (search) {
		conditions.push('(b.title LIKE ? OR b.note LIKE ?)');
		binds.push(`%${search}%`, `%${search}%`);
	}

	if (conditions.length > 0) {
		const where = ' WHERE ' + conditions.join(' AND ');
		query += where;
		countQuery += where;
	}

	const countResult = await db.prepare(countQuery).bind(...binds).first<{ total: number }>();
	const total = countResult?.total ?? 0;

	query += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
	const rows = await db.prepare(query).bind(...binds, limit, offset).all<BookmarkRow>();

	// Batch-fetch tags for all bookmarks (fixes N+1 query)
	const bookmarkIds = rows.results.map((b) => b.id);
	const tagMap = new Map<number, string[]>();

	if (bookmarkIds.length > 0) {
		const placeholders = bookmarkIds.map(() => '?').join(',');
		const allTags = await db
			.prepare(
				`SELECT bt.bookmark_id, t.name FROM tags t
				 JOIN bookmark_tags bt ON t.id = bt.tag_id
				 WHERE bt.bookmark_id IN (${placeholders})`,
			)
			.bind(...bookmarkIds)
			.all<{ bookmark_id: number; name: string }>();

		for (const row of allTags.results) {
			const list = tagMap.get(row.bookmark_id) || [];
			list.push(row.name);
			tagMap.set(row.bookmark_id, list);
		}
	}

	const bookmarks = rows.results.map((b) => ({
		...b,
		tags: tagMap.get(b.id) || [],
	}));

	return json({ bookmarks, total });
}

export async function updateBookmark(
	id: number,
	request: Request,
	db: D1Database,
	json: JsonFn,
): Promise<Response> {
	const existing = await db.prepare('SELECT id FROM bookmarks WHERE id = ?').bind(id).first();
	if (!existing) {
		return json({ error: 'Not found' }, 404);
	}

	const body = await parseJsonBody<UpdateBookmarkBody>(request);
	const updates: string[] = [];
	const binds: (string | number)[] = [];

	if (body.note !== undefined) {
		updates.push('note = ?');
		binds.push(body.note);
	}
	if (body.is_read !== undefined) {
		updates.push('is_read = ?');
		binds.push(body.is_read ? 1 : 0);
	}

	if (updates.length > 0) {
		updates.push('updated_at = ?');
		binds.push(new Date().toISOString());
		await db
			.prepare(`UPDATE bookmarks SET ${updates.join(', ')} WHERE id = ?`)
			.bind(...binds, id)
			.run();
	}

	if (body.tags !== undefined) {
		await syncBookmarkTags(db, id, body.tags);
	}

	const bookmark = await db.prepare('SELECT * FROM bookmarks WHERE id = ?').bind(id).first<BookmarkRow>();
	const tags = await db
		.prepare('SELECT t.name FROM tags t JOIN bookmark_tags bt ON t.id = bt.tag_id WHERE bt.bookmark_id = ?')
		.bind(id)
		.all<{ name: string }>();

	return json({ ...bookmark, tags: tags.results.map((t) => t.name) });
}

export async function deleteBookmark(id: number, db: D1Database, json: JsonFn): Promise<Response> {
	const existing = await db.prepare('SELECT id FROM bookmarks WHERE id = ?').bind(id).first();
	if (!existing) {
		return json({ error: 'Not found' }, 404);
	}

	await db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(id).run();
	await db.prepare('DELETE FROM bookmarks WHERE id = ?').bind(id).run();

	return json({ success: true });
}

export async function batchUpdateBookmarks(request: Request, db: D1Database, json: JsonFn): Promise<Response> {
	const body = await parseJsonBody<BatchUpdateBody>(request);

	if (!Array.isArray(body.updates)) {
		return json({ error: 'updates must be an array' }, 422);
	}

	let updated = 0;

	for (const update of body.updates) {
		const existing = await db.prepare('SELECT id FROM bookmarks WHERE id = ?').bind(update.id).first();
		if (!existing) continue;

		const fields: string[] = [];
		const binds: (string | number)[] = [];

		if (update.note !== undefined) {
			fields.push('note = ?');
			binds.push(update.note);
		}
		if (update.is_read !== undefined) {
			fields.push('is_read = ?');
			binds.push(update.is_read ? 1 : 0);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			binds.push(new Date().toISOString());
			await db
				.prepare(`UPDATE bookmarks SET ${fields.join(', ')} WHERE id = ?`)
				.bind(...binds, update.id)
				.run();
		}

		if (update.tags !== undefined) {
			await syncBookmarkTags(db, update.id, update.tags);
		}

		updated++;
	}

	return json({ updated });
}
