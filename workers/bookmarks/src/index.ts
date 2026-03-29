import type { Env, JsonFn } from './types';
import { HttpError } from './helpers';
import { createBookmark, listBookmarks, updateBookmark, deleteBookmark, batchUpdateBookmarks } from './bookmarks';
import { getTags, createTag, approveTag } from './tags';

function getCorsHeaders(origin: string): Record<string, string> {
	const allowed = origin === 'https://jeffrey-lean.com' || origin.startsWith('http://localhost');
	return {
		'Access-Control-Allow-Origin': allowed ? origin : 'https://jeffrey-lean.com',
		'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
}

function checkAuth(request: Request, apiKey: string, json: JsonFn): Response | null {
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.replace('Bearer ', '');
	if (token !== apiKey) {
		return json({ error: 'Unauthorized' }, 401);
	}
	return null;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || '';
		const corsHeaders = getCorsHeaders(origin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };
		const json: JsonFn = (data, status = 200) =>
			new Response(JSON.stringify(data), { status, headers: jsonHeaders });

		const requireAuth = () => checkAuth(request, env.API_KEY, json);

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
			if (err instanceof HttpError) {
				return json({ error: err.message }, err.status);
			}
			console.error('Unhandled error:', err);
			return json({ error: 'Internal server error' }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
