const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
async function test() {
    try {
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` }, body: 'grant_type=client_credentials&scope=integration' });
        const { access_token } = await tokenRes.json();
        const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };
        const url = `https://www.${DOMAIN}/api/v3/integration/facilities/140548/doctors/1396868/addresses/1750984`;

        async function tryPatch(body) {
            console.log("-> ", JSON.stringify(body));
            const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
            console.log("Status:", r.status, await r.text());
        }

        await tryPatch({ name: 'Test', insuranceSupport: ["private"] });
        await tryPatch({ name: 'Test', insuranceSupport: [{ id: 1 }] });
        await tryPatch({ name: 'Test', insuranceSupport: { private: true } });
        await tryPatch({ name: 'Test', insuranceSupport: [1] });

    } catch (e) { console.error(e); }
}
test();
