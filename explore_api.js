const fs = require('fs');
const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function explore() {
    const output = [];
    const log = (msg) => { output.push(msg); console.log(msg); };

    const basicAuth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const tokenRes = await fetch('https://www.' + DOMAIN + '/oauth/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basicAuth },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
    });
    const { access_token } = await tokenRes.json();
    log('TOKEN OK');
    const h = { 'Authorization': 'Bearer ' + access_token };

    // Facilities
    const facRes = await fetch('https://www.' + DOMAIN + '/api/v3/integration/facilities', { headers: h });
    const fac = await facRes.json();
    log('\n=== FACILITY ===');
    log(JSON.stringify(fac._items[0], null, 2));

    const facilityId = fac._items[0].id;

    // All Doctors
    const docRes = await fetch('https://www.' + DOMAIN + '/api/v3/integration/facilities/' + facilityId + '/doctors', { headers: h });
    const docs = await docRes.json();
    log('\n=== DOCTORS (summary) ===');
    for (const d of docs._items) {
        log(`  ${d.id}: ${d.name} | surname: ${d.surname || 'N/A'} | specialty: ${JSON.stringify(d.specializations || d.specialty || 'N/A')}`);
    }
    log('\n=== DOCTOR FULL SAMPLE ===');
    log(JSON.stringify(docs._items[0], null, 2));

    const doctorId = docs._items[0].id;

    // Addresses for doctor
    const endpoints = [
        `/facilities/${facilityId}/doctors/${doctorId}/addresses`,
        `/facilities/${facilityId}/doctors/${doctorId}/bookings`,
        `/facilities/${facilityId}/doctors/${doctorId}/slots`,
        `/facilities/${facilityId}/doctors/${doctorId}/services`,
        `/facilities/${facilityId}/services`,
        `/facilities/${facilityId}/insurances`,
        `/bookings`,
    ];

    for (const ep of endpoints) {
        try {
            const res = await fetch('https://www.' + DOMAIN + '/api/v3/integration' + ep, { headers: h });
            log(`\n=== ${ep} (status: ${res.status}) ===`);
            if (res.ok) {
                const body = await res.json();
                log(JSON.stringify(body, null, 2).substring(0, 1000));
            } else {
                const text = await res.text();
                log('ERROR: ' + text.substring(0, 300));
            }
        } catch (e) {
            log(`FETCH ERROR for ${ep}: ${e.message}`);
        }
    }

    fs.writeFileSync('explore_api.txt', output.join('\n'));
    log('\nOutput saved to explore_api.txt');
}
explore().catch(e => console.error(e));
