interface Env {
	VIEW_COUNTS: KVNamespace;
}

const BOT_PATTERN = /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|bingpreview|linkedinbot/i;
const DEDUP_TTL = 86400; // 24 hours in seconds

function getClientIp(request: Request): string {
	return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

function isBot(request: Request): boolean {
	const ua = request.headers.get('user-agent') || '';
	return BOT_PATTERN.test(ua);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || '';
		const allowed = origin === 'https://jeffrey-lean.com' || origin.startsWith('http://localhost');
		const corsHeaders: Record<string, string> = {
			'Access-Control-Allow-Origin': allowed ? origin : 'https://jeffrey-lean.com',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), { status, headers: jsonHeaders });

		// Batch read: POST /views/batch { slugs: ["a", "b"] }
		if (url.pathname === '/views/batch' && request.method === 'POST') {
			const body = await request.json<{ slugs: string[] }>();
			const counts: Record<string, number> = {};
			await Promise.all(
				body.slugs.map(async (slug) => {
					const val = await env.VIEW_COUNTS.get(slug);
					counts[slug] = parseInt(val || '0', 10);
				})
			);
			return json({ counts });
		}

		const match = url.pathname.match(/^\/views\/(.+)$/);
		if (!match) {
			return json({ error: 'Not found' }, 404);
		}

		const slug = decodeURIComponent(match[1]);

		// GET /views/:slug → read count without incrementing
		if (request.method === 'GET') {
			const current = parseInt((await env.VIEW_COUNTS.get(slug)) || '0', 10);
			return json({ slug, count: current });
		}

		// POST /views/:slug → increment with bot filtering and IP dedup
		if (request.method === 'POST') {
			if (isBot(request)) {
				const current = parseInt((await env.VIEW_COUNTS.get(slug)) || '0', 10);
				return json({ slug, count: current });
			}

			const ip = getClientIp(request);
			const dedupKey = `seen:${ip}:${slug}`;
			const alreadySeen = await env.VIEW_COUNTS.get(dedupKey);

			if (alreadySeen) {
				const current = parseInt((await env.VIEW_COUNTS.get(slug)) || '0', 10);
				return json({ slug, count: current });
			}

			const current = parseInt((await env.VIEW_COUNTS.get(slug)) || '0', 10);
			const count = current + 1;
			await Promise.all([
				env.VIEW_COUNTS.put(slug, count.toString()),
				env.VIEW_COUNTS.put(dedupKey, '1', { expirationTtl: DEDUP_TTL }),
			]);

			return json({ slug, count });
		}

		return json({ error: 'Method not allowed' }, 405);
	},
} satisfies ExportedHandler<Env>;
