const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function testUpdate() {
    try {
        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${basicAuth}`
            },
            body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
        });

        const { access_token } = await tokenRes.json();
        const headers = {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        const facRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities`, { headers });
        const facilities = await facRes.json();
        const facilityId = facilities._items[0].id;
        const docRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors`, { headers });
        const doctors = await docRes.json();
        const docId = doctors._items[0].id;
        const addrsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses`, { headers });
        const addrs = await addrsRes.json();
        const addrId = addrs._items[0].id;
        const addrUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`;

        console.log(`PATCH ${addrUrl}`);
        const patchRes = await fetch(addrUrl, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ name: 'Test Name Updated PATCH' })
        });
        const patchBody = await patchRes.json();
        console.log('PATCH Response:', patchRes.status, JSON.stringify(patchBody, null, 2));

    } catch (e) {
        console.error('Test Failed:', e);
    }
}

testUpdate();
