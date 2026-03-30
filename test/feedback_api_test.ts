import 'dotenv/config';

const API_BASE = process.env.RECEPTION_API_BASE_URL || 'http://localhost:3000';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';
const EMPLOYEE_ID = process.env.EMPLOYEE_ID || 'admin';

async function waitForHealth(timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`${API_BASE}/health`);
			if (r.ok) return;
		} catch {
			/* ignore */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error('Server /health did not respond in time');
}

async function fetchJson<T>(input: string | URL | Request, init?: RequestInit, error?: string): Promise<T> {
	const response = await fetch(input, init);
	if (!response.ok) {
		if (error) {
			const txt = await response.text();
			throw new Error(`${error}: ${response.status} ${txt}`);
		}
		throw new Error(`HTTP error! Status: ${response.status}`);
	}
	return (await response.json()) as T;
}

async function run() {
	await waitForHealth();

	// Missing headers -> should be rejected
	const noHeaderResp = await fetch(`${API_BASE}/feedback`);
	if (noHeaderResp.ok) {
		throw new Error('GET /feedback should require restaurant id header when not provided');
	}

	// With headers
	const headers = {
		'Content-Type': 'application/json',
		'X-Restaurant-Id': RESTAURANT_ID,
		'X-Employee-Id': EMPLOYEE_ID,
	};

	const list = await fetchJson<{ items: any[] }>(`${API_BASE}/feedback?limit=5`, { headers }, 'GET /feedback failed');
	if (!Array.isArray(list.items)) throw new Error('Invalid /feedback response format');

	const summary = await fetchJson<any>(`${API_BASE}/feedback/summary`, { headers }, 'GET /feedback/summary failed');
	if (!summary || typeof summary !== 'object') throw new Error('Invalid /feedback/summary response');

	console.log('✅ Feedback API basic checks passed');
}

run().catch((err) => {
	console.error('❌ Feedback API test failed:', err?.message || err);
	process.exit(1);
});
