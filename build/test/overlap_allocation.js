import 'dotenv/config';
const API_BASE = process.env.BACKEND_API_BASE_URL || 'http://localhost:3001';
const RESTAURANT_ID = process.env.RESTAURANT_ID || 'csrorganics';
async function waitForHealth(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`${API_BASE}/health`);
            if (r.ok) {
                const j = (await r.json().catch(() => ({})));
                if (!j.mongo || j.mongo.ok === true)
                    return;
            }
        }
        catch { }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('health timeout');
}
async function run() {
    await waitForHealth();
    const now = new Date();
    const slot = new Date(now.getTime() + 20 * 60 * 1000); // 20 mins future
    // First booking: 3 people, expect allocation (likely T2 or T3 4-top if no 3-top exists)
    const firstRes = await fetch(`${API_BASE}/add-booking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Restaurant-Id': RESTAURANT_ID },
        body: JSON.stringify({
            restaurantId: RESTAURANT_ID,
            customer: { name: 'Overlap-A', number: '+910000000010' },
            booking: { table_name: null, date: slot.toISOString(), duration: 90, number_of_people: 3 }
        })
    });
    if (!firstRes.ok)
        throw new Error(`First booking failed ${firstRes.status}`);
    const firstJson = (await firstRes.json());
    const firstTable = firstJson.table_name;
    if (!firstTable)
        throw new Error('First booking missing table allocation');
    // Second booking same slot: same party size 3, should allocate different table if capacity allows
    const secondRes = await fetch(`${API_BASE}/add-booking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Restaurant-Id': RESTAURANT_ID },
        body: JSON.stringify({
            restaurantId: RESTAURANT_ID,
            customer: { name: 'Overlap-B', number: '+910000000011' },
            booking: { table_name: null, date: slot.toISOString(), duration: 90, number_of_people: 3 }
        })
    });
    if (!secondRes.ok)
        throw new Error(`Second booking failed ${secondRes.status}`);
    const secondJson = (await secondRes.json());
    const secondTable = secondJson.table_name;
    if (!secondTable)
        throw new Error('Second booking missing table allocation');
    if (secondTable === firstTable) {
        console.warn('Warning: second booking reused same table. This could happen if allocation code allows reuse; verify logic.');
    }
    // Cleanup
    await fetch(`${API_BASE}/booking/${firstJson.booking_id}`, { method: 'DELETE', headers: { 'X-Restaurant-Id': RESTAURANT_ID } }).catch(() => { });
    await fetch(`${API_BASE}/booking/${secondJson.booking_id}`, { method: 'DELETE', headers: { 'X-Restaurant-Id': RESTAURANT_ID } }).catch(() => { });
    console.log('✅ Overlap allocation test passed', { firstTable, secondTable });
}
run().catch(err => { console.error('❌ Overlap allocation test failed', err); process.exit(1); });
//# sourceMappingURL=overlap_allocation.js.map