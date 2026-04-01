import 'dotenv/config';

const API_BASE = process.env.RECEPTION_API_BASE_URL || 'http://localhost:3000';
const RESTAURANT_ID = process.env.TEST_RESTAURANT_ID || 'csrorganics';
const EMPLOYEE_ID = process.env.TEST_EMPLOYEE_ID || 'admin';

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

// Generic helper to fetch and parse JSON with type safety
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
  const plate = `TEST-${Date.now()}`;

  interface CreateValetResponse {
    message: string;
    booking_id: string;
    entry_time: string;
  }

  // test adding a valet entry
  const createResponse = await fetchJson<CreateValetResponse>(`${API_BASE}/create_valet_record`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ number_plate: plate}),
  }, "POST /create_valet_record failed:");

  const booking_id = await createResponse.booking_id;

  console.log('✅ Valet Creation passed');

  // Test get valet info
  const r = await fetch(`${API_BASE}/get_valet_info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ booking_id: booking_id }),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GET /get_valet_info failed: ${r.status} ${txt}`);
  }

  const body = await r.json();
  if (!body || typeof body !== 'object' || !('booking_id' in body)) {
    console.error('Unexpected response body:', body);
    throw new Error('Valet response did not contain expected fields');
  }
  console.log('✅ Valet get info passed');

  // Test update valet state
  const updateResponse = await fetch(`${API_BASE}/update_valet_state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ booking_id: booking_id, state: 2 }),
  });

  if (!updateResponse.ok) {
    const txt = await updateResponse.text();
    throw new Error(`POST /update_valet_state failed: ${updateResponse.status} ${txt}`);
  }
  const bodyUVS = await updateResponse.json();
  if (!bodyUVS || typeof bodyUVS !== 'object' || !('booking_id' in bodyUVS)) {
    console.error('Unexpected response body:', bodyUVS);
    throw new Error('Valet response did not contain expected fields');
  }

  console.log('✅ Valet update state passed');
  // Add a bay via backend proxy to get a Bay_id
  const addBayRespEarly = await fetch(`${API_BASE}/add-valet-bay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ Bay_name: 'Main', total_capacity: 5 }),
  });

  if (!addBayRespEarly.ok) {
    const txt = await addBayRespEarly.text();
    throw new Error(`POST /add-valet-bay failed: ${addBayRespEarly.status} ${txt}`);
  }

  const addedEarly = await addBayRespEarly.json() as { Bay_id?: string | number };
  const bayIdToUse = addedEarly?.Bay_id;
  console.log('✅ add-valet-bay response (early):', addedEarly);

  // Test update valet bay using the Bay_id we just created
  const updateResponseBay = await fetch(`${API_BASE}/update_valet_bay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ booking_id: booking_id, bay_id: bayIdToUse }),
  });

  if (!updateResponseBay.ok) {
    const txt = await updateResponseBay.text();
    throw new Error(`POST /update_valet_bay failed: ${updateResponseBay.status} ${txt}`);
  }
  const bodyUVB = await updateResponseBay.json();
  if (!bodyUVB || typeof bodyUVB !== 'object' || !('booking_id' in bodyUVB)) {
    console.error('Unexpected response body:', bodyUVB);
    throw new Error('Valet response did not contain expected fields');
  }

  console.log('✅ Valet update bay passed');

  // Test fetching bays from backend proxy
  const baysResp = await fetch(`${API_BASE}/valet-bays`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
  });

  if (!baysResp.ok) {
    const txt = await baysResp.text();
    throw new Error(`GET /valet-bays failed: ${baysResp.status} ${txt}`);
  }

  const bays = await baysResp.json();
  console.log('✅ valet-bays response:', bays);

  // Test adding a bay via backend proxy
  const addBayResp = await fetch(`${API_BASE}/add-valet-bay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ Bay_name: 'Main', total_capacity: 5 }),
  });

  if (!addBayResp.ok) {
    const txt = await addBayResp.text();
    throw new Error(`POST /add-valet-bay failed: ${addBayResp.status} ${txt}`);
  }

  const added = await addBayResp.json();
  console.log('✅ add-valet-bay response:', added);

  // Test delete valet bay via backend proxy
  const deleteResp = await fetch(`${API_BASE}/delete-valet-bay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Restaurant-Id': RESTAURANT_ID,
      'X-Employee-Id': EMPLOYEE_ID,
    },
    body: JSON.stringify({ Bay_name: 'Main' }),
  });

  if (!deleteResp.ok) {
    const txt = await deleteResp.text();
    throw new Error(`POST /delete-valet-bay failed: ${deleteResp.status} ${txt}`);
  }

  const deleted = await deleteResp.json();
  console.log('✅ delete-valet-bay response:', deleted);

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
  console.log('✅✅ Valet API integration test passed');
}

run().catch((err) => {
  console.error('❌ Valet API test failed:', err?.message || err);
  process.exit(1);
});
