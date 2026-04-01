const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const fs = require('fs');

async function scan() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const facilityId = '140548';
    const docId = '1396868';
    const addrId = '1750984';
    const url = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services`;

    const services = {};
    const targets = ['cardiologia', 'clinico', 'oftalmologia', 'primeira consulta'];

    // Scan IDs 1-200 to find relevant services
    for (let id = 1; id <= 200; id++) {
        try {
            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ service_id: String(id), is_visible: true }) });
            if (res.status === 201) {
                const data = await res.json();
                services[id] = data.name;

                const nameLower = data.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const isTarget = targets.some(t => nameLower.includes(t));
                if (isTarget) {
                    console.log('*** FOUND: ID ' + id + ' -> ' + data.name);
                }

                // Delete immediately
                await fetch(`${url}/${data.id}`, { method: 'DELETE', headers });
            } else if (res.status === 409) {
                // Already exists - this is also useful info
                console.log('ALREADY EXISTS: ID ' + id);
            }
        } catch (e) {
            // Skip
        }

        // Rate limit safety
        if (id % 50 === 0) {
            console.log('Scanned ' + id + '/200...');
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Save results
    fs.writeFileSync('service_dictionary.json', JSON.stringify(services, null, 2));
    console.log('\nTotal services found: ' + Object.keys(services).length);
    console.log('Saved to service_dictionary.json');
}

scan().catch(console.error);
