const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function search() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    // Try fetching current doctor's address services to see what's already assigned
    const facilityId = '140548';

    // Get ALL doctors and their current services
    const docsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors`, { headers });
    const docs = await docsRes.json();

    for (const doc of (docs._items || [])) {
        console.log('Doctor: ' + doc.name + ' (ID: ' + doc.id + ')');

        const addrsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${doc.id}/addresses`, { headers });
        const addrs = await addrsRes.json();

        for (const addr of (addrs._items || [])) {
            console.log('  Address: ' + addr.name + ' (ID: ' + addr.id + ')');

            const svcsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${doc.id}/addresses/${addr.id}/services`, { headers });
            const svcs = await svcsRes.json();

            for (const svc of (svcs._items || [])) {
                console.log('    Service: ' + svc.name + ' (ID: ' + svc.id + ')');
            }
        }
        console.log('');
    }
}

search().catch(console.error);
