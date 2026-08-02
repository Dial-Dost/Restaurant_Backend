import 'dotenv/config';

const API_BASE = process.env.BACKEND_API_BASE_URL || 'http://localhost:3001';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';
const EMPLOYEE_ID = process.env.EMPLOYEE_ID || '84292cad-2c6d-4fe1-9221-a5fff1571c11';

async function waitForHealth(timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`${API_BASE}/health`);
			if (r.ok) {return;}
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
		'X-Outlet-Id': 'a5390f5a-f99c-4f8c-9916-ab5d6c4f8b99',
		'X-Action-List': "0cb6768b-92ff-4848-8631-52ef9d65cf53",
	};

	const list = await fetchJson<{ items: any[] }>(`${API_BASE}/feedback?limit=5`, { headers }, 'GET /feedback failed');
	if (!Array.isArray(list.items)) {throw new Error('Invalid /feedback response format');}

	const summary = await fetchJson<any>(`${API_BASE}/feedback/summary`, { headers }, 'GET /feedback/summary failed');
	if (!summary || typeof summary !== 'object') {throw new Error('Invalid /feedback/summary response');}

	// Test get_main_feedback_question
	const mainResp = await fetch(`${API_BASE}/get_main_feedback_question`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Restaurant-Id': RESTAURANT_ID,
		},
		body: JSON.stringify({ category: 2 }),
	});
	if (!mainResp.ok) {
		const txt = await mainResp.text();
		throw new Error(`/get_main_feedback_question failed: ${mainResp.status} ${txt}`);
	}
	const mainBody = await mainResp.json();
	if (!mainBody || typeof mainBody !== 'object') {
		throw new Error('Invalid response from /get_main_feedback_question');
	}
	console.log('✅ get_main_feedback_question passed');

	// Test get_follow_up_question
	const followResp = await fetch(`${API_BASE}/get_follow_up_question`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Restaurant-Id': RESTAURANT_ID,
		},
		body: JSON.stringify({ category: 1, rate: 4 }),
	});
	if (!followResp.ok) {
		const txt = await followResp.text();
		throw new Error(`/get_follow_up_question failed: ${followResp.status} ${txt}`);
	}
	const followBody = await followResp.json();
	if (!followBody || typeof followBody !== 'object') {
		throw new Error('Invalid response from /get_follow_up_question');
	}
	console.log('✅ get_follow_up_question passed');

	console.log('✅ Feedback API basic checks passed');
}

run().catch((err) => {
	console.error('❌ Feedback API test failed:', err?.message || err);
	process.exit(1);
});
