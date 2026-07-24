import 'dotenv/config';
const API_BASE = process.env.BACKEND_API_BASE_URL || 'http://localhost:3001';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';

async function waitForHealth(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${API_BASE}/health`);
      if (r.ok) {
        const j = (await r.json().catch(() => ({})));
        if (!j.mongo || j.mongo.ok === true) {return;}
      }
    } catch { }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('health timeout');
}

async function run() {
  await waitForHealth();
  const now = new Date();
  const slot = new Date(now.getTime() + 30 * 60 * 1000); // 30 mins future

  const created: string[] = [];

  // Keep creating 2-person bookings until allocation returns 409
  while (true) {
    const res = await fetch(`${API_BASE}/add-booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Id': RESTAURANT_ID },
      body: JSON.stringify({
        restaurantId: RESTAURANT_ID,
        customer: { name: `Threshold-${created.length}`, number: `+9100000002${(created.length % 10)}` },
        booking: { table_name: null, date: slot.toISOString(), duration: 60, number_of_people: 2 }
      })
    });

    if (res.status === 409) {
      break; // reached capacity threshold
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Unexpected failure while filling capacity: ${res.status} ${txt}`);
    }
    const j = (await res.json());
    created.push(j.booking_id);
    if (created.length > 20) {
      throw new Error('Capacity threshold test created > 20 bookings unexpectedly; check seed tables');
    }
  }

  // Cleanup
  await Promise.all(
    created.map(id => fetch(`${API_BASE}/booking/${id}`, { method: 'DELETE', headers: { 'X-Restaurant-Id': RESTAURANT_ID } }).catch(() => { }))
  );

  console.log('✅ Capacity threshold test passed. Bookings created before 409:', created.length);
}

run().catch(err => { console.error('❌ Capacity threshold test failed', err); process.exit(1); });
