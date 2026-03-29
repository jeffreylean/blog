export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || '';
		const allowed = origin === 'https://jeffrey-lean.com' || origin.startsWith('http://localhost');
		const corsHeaders = {
			'Access-Control-Allow-Origin': allowed ? origin : 'https://jeffrey-lean.com',
			'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };
		const json = (data, status = 200) =>
			new Response(JSON.stringify(data), { status, headers: jsonHeaders });

		// Auth check for write endpoints
		const requireAuth = () => {
			const authHeader = request.headers.get('Authorization') || '';
			const token = authHeader.replace('Bearer ', '');
			if (token !== env.API_KEY) {
				return json({ error: 'Unauthorized' }, 401);
			}
			return null;
		};

		const writeMethods = ['POST', 'PATCH', 'DELETE'];

		try {
			// --- Tag endpoints ---
			if (url.pathname === '/tags') {
				if (request.method === 'GET') {
					return await getTags(env.DB, json);
				}
				if (request.method === 'POST') {
					const authErr = requireAuth();
					if (authErr) return authErr;
					return await createTag(request, env.DB, json);
				}
			}

			if (url.pathname === '/tags/approve' && request.method === 'POST') {
				const authErr = requireAuth();
				if (authErr) return authErr;
				return await approveTag(request, env.DB, json);
			}

			// --- Bookmark batch endpoint ---
			if (url.pathname === '/bookmarks/batch' && request.method === 'POST') {
				const authErr = requireAuth();
				if (authErr) return authErr;
				return await batchUpdateBookmarks(request, env.DB, json);
			}

			// --- Bookmark CRUD ---
			if (url.pathname === '/bookmarks') {
				if (request.method === 'GET') {
					return await listBookmarks(url, env.DB, json);
				}
				if (request.method === 'POST') {
					const authErr = requireAuth();
					if (authErr) return authErr;
					return await createBookmark(request, env.DB, json);
				}
			}

			const bookmarkMatch = url.pathname.match(/^\/bookmarks\/(\d+)$/);
			if (bookmarkMatch) {
				const id = parseInt(bookmarkMatch[1], 10);
				if (request.method === 'PATCH') {
					const authErr = requireAuth();
					if (authErr) return authErr;
					return await updateBookmark(id, request, env.DB, json);
				}
				if (request.method === 'DELETE') {
					const authErr = requireAuth();
					if (authErr) return authErr;
					return await deleteBookmark(id, env.DB, json);
				}
			}

			return json({ error: 'Not found' }, 404);
		} catch (err) {
			return json({ error: 'Internal server error' }, 500);
		}
	},
};

// --- Bookmark handlers ---

async function createBookmark(request, db, json) {
	const body = await request.json();
	const { url: bookmarkUrl } = body;

	if (!bookmarkUrl || !isValidUrl(bookmarkUrl)) {
		return json({ error: 'Invalid URL' }, 422);
	}

	// Check duplicate
	const existing = await db.prepare('SELECT id FROM bookmarks WHERE url = ?').bind(bookmarkUrl).first();
	if (existing) {
		return json({ error: 'Bookmark already exists' }, 409);
	}

	// Auto-fetch title
	let title = bookmarkUrl;
	try {
		const resp = await fetch(bookmarkUrl, {
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
		.bind(bookmarkUrl, title, now, now)
		.run();

	return json({ id: result.meta.last_row_id, url: bookmarkUrl, title, created_at: now }, 201);
}

async function listBookmarks(url, db, json) {
	const tag = url.searchParams.get('tag');
	const search = url.searchParams.get('search');
	const untagged = url.searchParams.get('untagged');
	const unread = url.searchParams.get('unread');
	const limit = parseInt(url.searchParams.get('limit') || '50', 10);
	const offset = parseInt(url.searchParams.get('offset') || '0', 10);

	let countQuery = 'SELECT COUNT(DISTINCT b.id) as total FROM bookmarks b';
	let query = 'SELECT DISTINCT b.* FROM bookmarks b';
	const conditions = [];
	const binds = [];

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

	// Get total count
	const countResult = await db.prepare(countQuery).bind(...binds).first();
	const total = countResult.total;

	query += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
	const rows = await db.prepare(query).bind(...binds, limit, offset).all();

	// Attach tags to each bookmark
	const bookmarks = await Promise.all(
		rows.results.map(async (b) => {
			const tags = await db
				.prepare(
					'SELECT t.name FROM tags t JOIN bookmark_tags bt ON t.id = bt.tag_id WHERE bt.bookmark_id = ?'
				)
				.bind(b.id)
				.all();
			return { ...b, tags: tags.results.map((t) => t.name) };
		})
	);

	return json({ bookmarks, total });
}

async function updateBookmark(id, request, db, json) {
	const existing = await db.prepare('SELECT id FROM bookmarks WHERE id = ?').bind(id).first();
	if (!existing) {
		return json({ error: 'Not found' }, 404);
	}

	const body = await request.json();
	const updates = [];
	const binds = [];

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

	// Handle tags
	if (body.tags !== undefined) {
		// Delete existing tags
		await db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(id).run();

		for (const tagName of body.tags) {
			let tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first();
			if (!tag) {
				// Create as pending (not approved)
				const result = await db
					.prepare('INSERT INTO tags (name, is_approved) VALUES (?, 0)')
					.bind(tagName)
					.run();
				tag = { id: result.meta.last_row_id };
			}
			await db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)').bind(id, tag.id).run();
		}
	}

	// Return updated bookmark with tags
	const bookmark = await db.prepare('SELECT * FROM bookmarks WHERE id = ?').bind(id).first();
	const tags = await db
		.prepare('SELECT t.name FROM tags t JOIN bookmark_tags bt ON t.id = bt.tag_id WHERE bt.bookmark_id = ?')
		.bind(id)
		.all();

	return json({ ...bookmark, tags: tags.results.map((t) => t.name) });
}

async function deleteBookmark(id, db, json) {
	const existing = await db.prepare('SELECT id FROM bookmarks WHERE id = ?').bind(id).first();
	if (!existing) {
		return json({ error: 'Not found' }, 404);
	}

	await db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(id).run();
	await db.prepare('DELETE FROM bookmarks WHERE id = ?').bind(id).run();

	return json({ success: true });
}

// --- Tag handlers ---

async function getTags(db, json) {
	const all = await db.prepare('SELECT * FROM tags ORDER BY name').all();
	const approved = all.results.filter((t) => t.is_approved === 1);
	const pending = all.results.filter((t) => t.is_approved === 0);
	return json({ approved, pending });
}

async function createTag(request, db, json) {
	const body = await request.json();
	const { name } = body;

	if (!name) {
		return json({ error: 'Tag name required' }, 422);
	}

	const existing = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first();
	if (existing) {
		return json({ error: 'Tag already exists' }, 409);
	}

	const result = await db.prepare('INSERT INTO tags (name, is_approved) VALUES (?, 1)').bind(name).run();
	return json({ id: result.meta.last_row_id, name, is_approved: 1 }, 201);
}

async function approveTag(request, db, json) {
	const body = await request.json();
	const { name } = body;

	const tag = await db.prepare('SELECT id, is_approved FROM tags WHERE name = ?').bind(name).first();
	if (!tag) {
		return json({ error: 'Tag not found' }, 404);
	}

	await db.prepare('UPDATE tags SET is_approved = 1 WHERE id = ?').bind(tag.id).run();
	return json({ id: tag.id, name, is_approved: 1 });
}

// --- Batch update ---

async function batchUpdateBookmarks(request, db, json) {
	const body = await request.json();
	const { updates } = body;

	if (!Array.isArray(updates)) {
		return json({ error: 'updates must be an array' }, 422);
	}

	let updated = 0;

	for (const update of updates) {
		const { id, tags, note, is_read } = update;
		const existing = await db.prepare('SELECT id FROM bookmarks WHERE id = ?').bind(id).first();
		if (!existing) continue;

		const fields = [];
		const binds = [];

		if (note !== undefined) {
			fields.push('note = ?');
			binds.push(note);
		}
		if (is_read !== undefined) {
			fields.push('is_read = ?');
			binds.push(is_read ? 1 : 0);
		}

		if (fields.length > 0) {
			fields.push('updated_at = ?');
			binds.push(new Date().toISOString());
			await db
				.prepare(`UPDATE bookmarks SET ${fields.join(', ')} WHERE id = ?`)
				.bind(...binds, id)
				.run();
		}

		if (tags !== undefined) {
			await db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').bind(id).run();
			for (const tagName of tags) {
				let tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first();
				if (!tag) {
					const result = await db
						.prepare('INSERT INTO tags (name, is_approved) VALUES (?, 0)')
						.bind(tagName)
						.run();
					tag = { id: result.meta.last_row_id };
				}
				await db
					.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)')
					.bind(id, tag.id)
					.run();
			}
		}

		updated++;
	}

	return json({ updated });
}

// --- Helpers ---

function isValidUrl(str) {
	try {
		const url = new URL(str);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
