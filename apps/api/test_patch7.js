const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function testUpdate() {
    try {
        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
            body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
        });

        const { access_token } = await tokenRes.json();
        const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

        const facilityId = '140548';
        const docId = '1396868';
        const addrId = '1750984';
        const addrUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`;

        async function tryPatch(bodyObj) {
            console.log("Trying:", JSON.stringify(bodyObj));
            const patchRes = await fetch(addrUrl, { method: 'PATCH', headers, body: JSON.stringify(bodyObj) });
            console.log('PATCH Status:', patchRes.status, await patchRes.text());
        }

        await tryPatch({ name: 'Medical Center Bruno Mendes Test', city: 'Vila Tomás do Leste', booking_extra_fields: { insurance: false } });

    } catch (e) {
        console.error(e);
    }
}
testUpdate();
