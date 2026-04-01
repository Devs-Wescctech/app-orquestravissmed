const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function test() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const facilityId = '140548';
    const docId = '1396868'; // Aaron
    const addrId = '1750984';

    // Get current address to see all fields
    const getRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, { headers });
    const addr = await getRes.json();
    console.log('Current insurance flag:', addr.booking_extra_fields?.insurance);
    console.log('Current name:', addr.name);
    console.log('Current street:', addr.street);
    console.log('Current city:', addr.city);
    console.log('Current post_code:', addr.post_code);

    // Test various payloads
    const tests = [
        {
            label: 'Test 1: with insuranceSupport: []',
            payload: { name: 'Clinica VisMed Test', street: 'Rua Teste 123', city: 'Sao Paulo', insuranceSupport: [] }
        },
        {
            label: 'Test 2: with booking_extra_fields.insurance: false + data',
            payload: { name: 'Clinica VisMed Test', street: 'Rua Teste 123', booking_extra_fields: { insurance: false } }
        },
        {
            label: 'Test 3: PUT instead of PATCH',
            method: 'PUT',
            payload: { ...addr, name: 'Clinica VisMed Test', street: 'Rua Teste 123' }
        },
        {
            label: 'Test 4: Only name field',
            payload: { name: 'Clinica VisMed Test' }
        }
    ];

    for (const t of tests) {
        console.log('\n=== ' + t.label + ' ===');
        const method = t.method || 'PATCH';
        const url = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`;
        const res = await fetch(url, { method, headers, body: JSON.stringify(t.payload) });
        console.log(method + ' Status:', res.status);
        if (res.status === 204 || res.status === 200) {
            console.log('SUCCESS!');
            const text = await res.text();
            if (text) console.log('Body:', text.substring(0, 200));
            break; // Stop on success
        } else {
            const text = await res.text();
            console.log('Error:', text.substring(0, 300));
        }
    }
}

test().catch(console.error);
