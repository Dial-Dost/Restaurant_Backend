import 'dotenv/config';

const API_BASE = process.env.RECEPTION_API_BASE_URL || 'http://localhost:3000';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';

async function waitForHealth(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${API_BASE}/health`);
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as any;
        if (!j.mongo || j.mongo.ok === true) return; // proceed when healthy or no mongo field
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Server /health did not respond with mongo ok in time');
}

async function testBestFitAlloc(): Promise<void> {
  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * 60 * 1000);
  const unique = `AllocTest-${now.toISOString().replace(/[:.]/g, '-')}`;

  const postRes = await fetch(`${API_BASE}/add-booking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
    },
    body: JSON.stringify({
      restaurantId: RESTAURANT_ID,
      customer: { name: unique, number: '+910000000001' },
      booking: {
        table_name: null,
        date: in15.toISOString(),
        duration: 60,
        number_of_people: 3,
        source: 'AllocationTest',
        status: 'Confirmed',
        from: 'integration',
        notes: 'Allocation best-fit test',
      },
    }),
  });

  if (!postRes.ok) {
    const txt = await postRes.text();
    throw new Error(`Best-fit POST failed: ${postRes.status} ${txt}`);
  }
  const postJson = (await postRes.json()) as { booking_id: string; table_name?: string | null };
  if (!postJson.booking_id) throw new Error('Missing booking_id in best-fit response');
  if (!postJson.table_name) throw new Error('Expected server to allocate a table_name');
  if (postJson.table_name === 'T1') throw new Error('Allocated a 2-top for a 3-person party, expected >= 3 capacity');

  // cleanup
  await fetch(`${API_BASE}/booking/${postJson.booking_id}`, {
    method: 'DELETE',
    headers: { 'X-Restaurant-Id': RESTAURANT_ID },
  }).catch(() => {});
}

async function testNoCapacity409(): Promise<void> {
  const now = new Date();
  const in10 = new Date(now.getTime() + 10 * 60 * 1000);
  const unique = `AllocFail-${now.toISOString().replace(/[:.]/g, '-')}`;

  const tooLargeParty = 50; // larger than any seeded table capacity
  const postRes = await fetch(`${API_BASE}/add-booking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
    },
    body: JSON.stringify({
      restaurantId: RESTAURANT_ID,
      customer: { name: unique, number: '+910000000002' },
      booking: {
        table_name: null,
        date: in10.toISOString(),
        duration: 60,
        number_of_people: tooLargeParty,
        source: 'AllocationTest',
        status: 'Confirmed',
        from: 'integration',
        notes: 'Expect 409 no table available',
      },
    }),
  });

  if (postRes.status !== 409) {
    const txt = await postRes.text();
    throw new Error(`Expected 409 for oversized party, got ${postRes.status} ${txt}`);
  }
}

async function run() {
  await waitForHealth();
  await testBestFitAlloc();
  await testNoCapacity409();
  console.log('✅ Allocation integration tests passed');
}

run().catch((err) => {
  console.error('❌ Allocation integration tests failed:', err?.message || err);
  process.exit(1);
});
