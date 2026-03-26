import 'dotenv/config';
import http from 'http';
import { date } from 'zod/v4';

const API_BASE = process.env.RECEPTION_API_BASE_URL || 'http://localhost:3000';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';

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

async function run() {
  await waitForHealth();
  const plate = `TEST-${Date.now()}`;

  // test adding a valet entry
    const createResponse = await fetch(`${API_BASE}/update_valet_state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
    },
    body: JSON.stringify({ number_plate: plate, state: 0 }),
  });

  if (!createResponse.ok) {
    const txt = await createResponse.text();
    throw new Error(`POST /update_valet_state failed: ${createResponse.status} ${txt}`);
  }

  console.log('✅ Valet Creation passed');

  // Test get valet state
  const r = await fetch(`${API_BASE}/get_valet_state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
    },
    body: JSON.stringify({ number_plate: plate }),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GET /get_valet_state failed: ${r.status} ${txt}`);
  }

  const body = await r.json();
  if (!body || typeof body !== 'object' || !('valet_state' in body)) {
    console.error('Unexpected response body:', body);
    throw new Error('Valet response did not contain expected fields');
  }
  console.log('✅ Valet get state passed');

  // Test update valet state
  const updateResponse = await fetch(`${API_BASE}/update_valet_state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
    },
    body: JSON.stringify({ number_plate: plate, state: 2 }),
  });

  if (!updateResponse.ok) {
    const txt = await updateResponse.text();
    throw new Error(`POST /update_valet_state failed: ${updateResponse.status} ${txt}`);
  }

  console.log('✅ Valet update state passed');
  console.log('✅✅ Valet API integration test passed');
}

run().catch((err) => {
  console.error('❌ Valet API test failed:', err?.message || err);
  process.exit(1);
});
