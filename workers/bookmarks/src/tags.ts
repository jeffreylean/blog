import type { JsonFn, TagRow, CreateTagBody, ApproveTagBody } from './types';
import { parseJsonBody, validateTagName, HttpError } from './helpers';

export async function getTags(db: D1Database, json: JsonFn): Promise<Response> {
	const all = await db.prepare('SELECT * FROM tags ORDER BY name').all<TagRow>();
	const approved = all.results.filter((t) => t.is_approved === 1);
	const pending = all.results.filter((t) => t.is_approved === 0);
	return json({ approved, pending });
}

export async function createTag(request: Request, db: D1Database, json: JsonFn): Promise<Response> {
	const body = await parseJsonBody<CreateTagBody>(request);

	if (!body.name) {
		return json({ error: 'Tag name required' }, 422);
	}

	if (!validateTagName(body.name)) {
		throw new HttpError(422, 'Invalid tag name: must be 1-50 lowercase alphanumeric characters or hyphens');
	}

	const existing = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(body.name).first();
	if (existing) {
		return json({ error: 'Tag already exists' }, 409);
	}

	const result = await db.prepare('INSERT INTO tags (name, is_approved) VALUES (?, 1)').bind(body.name).run();
	return json({ id: result.meta.last_row_id, name: body.name, is_approved: 1 }, 201);
}

export async function approveTag(request: Request, db: D1Database, json: JsonFn): Promise<Response> {
	const body = await parseJsonBody<ApproveTagBody>(request);

	const tag = await db
		.prepare('SELECT id, is_approved FROM tags WHERE name = ?')
		.bind(body.name)
		.first<{ id: number; is_approved: number }>();
	if (!tag) {
		return json({ error: 'Tag not found' }, 404);
	}

	await db.prepare('UPDATE tags SET is_approved = 1 WHERE id = ?').bind(tag.id).run();
	return json({ id: tag.id, name: body.name, is_approved: 1 });
}
