const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function testApi() {
    try {
        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
            body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
        });

        const { access_token } = await tokenRes.json();
        const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

        // Test Add Service
        const facilityId = '140548';
        const docId = '1396868';
        const addrId = '1750984';

        const serviceUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services`;
        console.log(`POST ${serviceUrl}`);
        const postRes = await fetch(serviceUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ item_id: 1, is_price_from: false })
        });
        const pb = await postRes.text();
        console.log('POST Response:', postRes.status, pb);

        if (postRes.status === 405) {
            console.log(`Trying PUT ${serviceUrl}`);
            const putRes = await fetch(serviceUrl, { method: 'PUT', headers, body: JSON.stringify([{ item_id: 1 }]) });
            console.log('PUT Response:', putRes.status, await putRes.text());
        }

    } catch (e) {
        console.error('Test Failed:', e);
    }
}
testApi();
