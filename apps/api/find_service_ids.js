const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function run() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const facilityId = '140548';

    // Get ALL doctors, ALL addresses, ALL services with FULL details
    const docsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors`, { headers });
    const docs = await docsRes.json();

    console.log('=== ALL SERVICE DETAILS (looking for service_id field) ===\n');

    for (const doc of (docs._items || [])) {
        const addrsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${doc.id}/addresses`, { headers });
        const addrs = await addrsRes.json();

        for (const addr of (addrs._items || [])) {
            const svcsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${doc.id}/addresses/${addr.id}/services`, { headers });
            const svcs = await svcsRes.json();

            const items = svcs._items || [];
            if (items.length > 0) {
                console.log('Doctor: ' + doc.name + ' | Address: ' + addr.id);
                for (const svc of items) {
                    console.log(JSON.stringify(svc, null, 2));
                }
            }
        }
    }

    // Also try to POST with string ID
    console.log('\n=== TESTING POST WITH STRING AND INT service_id ===');
    const testBody1 = { service_id: "1", is_visible: true };
    const testBody2 = { service_id: 1, is_visible: true };

    const url = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/1396868/addresses/1750984/services`;

    console.log('POST with string service_id "1":');
    const r1 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(testBody1) });
    console.log('Status:', r1.status, await r1.text());

    console.log('\nPOST with int service_id 1:');
    const r2 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(testBody2) });
    console.log('Status:', r2.status, await r2.text());
}

run().catch(console.error);
