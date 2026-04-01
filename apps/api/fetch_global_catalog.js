const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const fs = require('fs');

async function run() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}` };

    // Try the global /services endpoint (not facility-specific)
    const urls = [
        `https://www.${DOMAIN}/api/v3/integration/services`,
        `https://www.${DOMAIN}/api/v3/integration/facilities/140548/services?limit=1000`
    ];

    for (const url of urls) {
        console.log('GET ' + url);
        const res = await fetch(url, { headers });
        console.log('Status: ' + res.status);
        if (res.ok) {
            const data = await res.json();
            const items = data._items || [];
            console.log('Items: ' + items.length);

            // Search for cardiologia, oftalmologia, clinico
            const targets = ['cardiolog', 'oftalmolog', 'clinico', 'primeira consulta'];
            for (const t of targets) {
                const found = items.filter(i => i.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(t));
                if (found.length > 0) {
                    console.log('\n"' + t + '":');
                    found.slice(0, 5).forEach(f => console.log('  ID:' + f.id + ' - ' + f.name));
                }
            }

            fs.writeFileSync('global_catalog.json', JSON.stringify(items, null, 2));
            console.log('\nSaved ' + items.length + ' services');
            break;
        }
        console.log('');
    }
}

run().catch(console.error);
