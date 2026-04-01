const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const { PrismaClient } = require('@prisma/client');
const stringSimilarity = require('string-similarity');
const prisma = new PrismaClient();

function normalize(str) {
    if (!str) return '';
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

async function run() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}` };

    // Try catalog
    console.log('Fetching catalog...');
    const catRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/140548/services`, { headers });
    console.log('Catalog status:', catRes.status);

    if (catRes.ok) {
        const catalog = await catRes.json();
        const services = catalog._items || [];
        console.log('Total services: ' + services.length);

        // Save to file and import
        const fs = require('fs');
        fs.writeFileSync('catalog_cache.json', JSON.stringify(services, null, 2));
        console.log('Saved to catalog_cache.json');

        // Import to DB
        for (const item of services) {
            await prisma.doctoraliaService.upsert({
                where: { doctoraliaServiceId: String(item.id) },
                update: { name: item.name, normalizedName: normalize(item.name) },
                create: { doctoraliaServiceId: String(item.id), name: item.name, normalizedName: normalize(item.name) }
            });
        }
        console.log('Imported ' + services.length + ' services');

        // Find matches for Cardiologia, Clinico Geral, Oftalmologia
        const targets = ['Cardiologia', 'Clínico Geral', 'Oftalmologia'];
        for (const t of targets) {
            const normT = normalize(t);
            let best = null, bestScore = 0;
            for (const svc of services) {
                const normS = normalize(svc.name);
                const containsScore = normS.includes(normT) ? 0.90 : 0;
                const simScore = stringSimilarity.compareTwoStrings(normT, normS);
                const score = Math.max(containsScore, simScore);
                if (score > bestScore) { bestScore = score; best = svc; }
            }
            console.log(t + ' -> ' + (best ? best.name : 'N/A') + ' (score: ' + bestScore.toFixed(3) + ', ID: ' + (best ? best.id : '-') + ')');
        }
    } else {
        console.log('Catalog not available. Status:', catRes.status);
        const text = await catRes.text();
        console.log(text.substring(0, 200));
    }

    await prisma.$disconnect();
}

run().catch(console.error);
