export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || '';
		const allowed = origin === 'https://jeffrey-lean.com' || origin.startsWith('http://localhost');
		const corsHeaders = {
			'Access-Control-Allow-Origin': allowed ? origin : 'https://jeffrey-lean.com',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };

		// Batch read: POST /views/batch { slugs: ["a", "b"] }
		if (url.pathname === '/views/batch' && request.method === 'POST') {
			const { slugs } = await request.json();
			const counts = {};
			await Promise.all(
				slugs.map(async (slug) => {
					const val = await env.VIEW_COUNTS.get(slug);
					counts[slug] = parseInt(val || '0', 10);
				})
			);
			return new Response(JSON.stringify({ counts }), { headers: jsonHeaders });
		}

		// Single view: GET /views/:slug (increments count)
		const match = url.pathname.match(/^\/views\/(.+)$/);
		if (!match) {
			return new Response(JSON.stringify({ error: 'Not found' }), {
				status: 404,
				headers: jsonHeaders,
			});
		}

		const slug = decodeURIComponent(match[1]);
		const current = parseInt((await env.VIEW_COUNTS.get(slug)) || '0', 10);
		const count = current + 1;
		await env.VIEW_COUNTS.put(slug, count.toString());

		return new Response(JSON.stringify({ slug, count }), { headers: jsonHeaders });
	},
};
