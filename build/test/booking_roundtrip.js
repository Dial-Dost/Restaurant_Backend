import 'dotenv/config';
const API_BASE = process.env.RECEPTION_API_BASE_URL || 'http://localhost:3000';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';
async function waitForHealth(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`${API_BASE}/health`);
            if (r.ok)
                return;
        }
        catch {
            /* ignore */
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Server /health did not respond in time');
}
async function run() {
    await waitForHealth();
    // Create a unique test booking 10 minutes in the future
    const now = new Date();
    const in10 = new Date(now.getTime() + 10 * 60 * 1000);
    const unique = `ITest-${now.toISOString().replace(/[:.]/g, '-')}`;
    // 1) POST /add-booking
    const postRes = await fetch(`${API_BASE}/add-booking`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Restaurant-Id': RESTAURANT_ID,
        },
        body: JSON.stringify({
            restaurantId: RESTAURANT_ID,
            customer: { name: unique, number: '+910000000000' },
            booking: {
                table_name: null,
                date: in10.toISOString(),
                duration: 60,
                number_of_people: 3,
                source: 'IntegrationTest',
                status: 'Confirmed',
                from: 'integration',
                notes: 'Round-trip test',
            },
        }),
    });
    if (!postRes.ok) {
        const txt = await postRes.text();
        throw new Error(`POST /add-booking failed: ${postRes.status} ${txt}`);
    }
    const postJson = (await postRes.json());
    if (!postJson.booking_id)
        throw new Error('Missing booking_id in response');
    // 2) GET /get-bookings and assert the id is present
    const getRes = await fetch(`${API_BASE}/get-bookings?restaurantId=${encodeURIComponent(RESTAURANT_ID)}`, { headers: { 'X-Restaurant-Id': RESTAURANT_ID } });
    if (!getRes.ok) {
        const txt = await getRes.text();
        throw new Error(`GET /get-bookings failed: ${getRes.status} ${txt}`);
    }
    const bookings = (await getRes.json());
    const hit = bookings.find((b) => b.booking_id === postJson.booking_id);
    if (!hit) {
        throw new Error('Round-trip booking not found in GET /get-bookings');
    }
    // 3) Optional cleanup: delete the booking to keep DB tidy
    await fetch(`${API_BASE}/booking/${postJson.booking_id}`, {
        method: 'DELETE',
        headers: { 'X-Restaurant-Id': RESTAURANT_ID },
    }).catch(() => { });
    console.log('✅ Integration round-trip passed:', postJson.booking_id);
}
run().catch((err) => {
    console.error('❌ Integration test failed:', err?.message || err);
    process.exit(1);
});
//# sourceMappingURL=booking_roundtrip.js.map