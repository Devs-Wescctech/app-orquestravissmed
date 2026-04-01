const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const stringSimilarity = require('string-similarity');

function normalize(str) {
    if (!str) return '';
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

async function analyze() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const catRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/140548/services`, { headers });
    const catalog = await catRes.json();
    const services = catalog._items || [];

    console.log('Total servicos catalogo Doctoralia: ' + services.length);

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const vmSpecs = await prisma.vismedSpecialty.findMany({ orderBy: { name: 'asc' } });

    console.log('Total especialidades VisMed: ' + vmSpecs.length);
    console.log('');

    let exact = 0, fuzzy = 0, none = 0;

    for (const spec of vmSpecs) {
        const normSpec = normalize(spec.name);
        let bestMatch = null;
        let bestScore = 0;

        for (const svc of services) {
            const normSvc = normalize(svc.name);
            // Check if specialty name is contained in service name
            const containsScore = normSvc.includes(normSpec) ? 0.90 : 0;
            const simScore = stringSimilarity.compareTwoStrings(normSpec, normSvc);
            const score = Math.max(containsScore, simScore);

            if (score > bestScore) {
                bestScore = score;
                bestMatch = svc;
            }
        }

        let icon;
        if (bestScore >= 0.85) { icon = 'OK'; exact++; }
        else if (bestScore >= 0.50) { icon = '~~'; fuzzy++; }
        else { icon = 'NO'; none++; }

        console.log(icon + ' | ' + spec.name + ' -> ' + (bestMatch ? bestMatch.name : 'N/A') + ' (ID:' + (bestMatch ? bestMatch.id : '-') + ' score:' + bestScore.toFixed(3) + ')');
    }

    console.log('');
    console.log('Match >= 0.85: ' + exact);
    console.log('Match 0.50-0.84: ' + fuzzy);
    console.log('Sem match: ' + none);

    await prisma.$disconnect();
}

analyze().catch(e => { console.error('ERROR:', e.message); });
