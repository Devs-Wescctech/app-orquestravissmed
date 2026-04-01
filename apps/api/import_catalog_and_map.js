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

async function importAndMap() {
    // 1. Fetch catalog from Doctoralia API
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    console.log('Fetching service catalog from Doctoralia...');
    const catRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/140548/services`, { headers });

    if (!catRes.ok) {
        console.error('Catalog fetch failed with status:', catRes.status);
        await prisma.$disconnect();
        return;
    }

    const catalog = await catRes.json();
    const services = catalog._items || [];
    console.log('Catalog items: ' + services.length);

    // 2. Import all services into DoctoraliaService table
    let imported = 0;
    for (const item of services) {
        const svcId = String(item.id);
        await prisma.doctoraliaService.upsert({
            where: { doctoraliaServiceId: svcId },
            update: { name: item.name, normalizedName: normalize(item.name) },
            create: { doctoraliaServiceId: svcId, name: item.name, normalizedName: normalize(item.name) }
        });
        imported++;
    }
    console.log('Imported ' + imported + ' services into DB');

    // 3. Now run matching for all unmapped specialties
    const unmapped = await prisma.vismedSpecialty.findMany({
        where: { mappings: { none: { isActive: true } } }
    });
    const allServices = await prisma.doctoraliaService.findMany();

    console.log('\nMatching ' + unmapped.length + ' unmapped specialties against ' + allServices.length + ' services...\n');

    let matched = 0;
    for (const spec of unmapped) {
        const normSpec = normalize(spec.name);

        // Contains match
        let best = null;
        let bestScore = 0;

        for (const svc of allServices) {
            const normSvc = normalize(svc.name);

            // Contains check
            if (normSvc.includes(normSpec) || normSpec.includes(normSvc)) {
                if (0.90 > bestScore) {
                    bestScore = 0.90;
                    best = svc;
                }
            }

            // Similarity check
            const sim = stringSimilarity.compareTwoStrings(normSpec, normSvc);
            if (sim > bestScore) {
                bestScore = sim;
                best = svc;
            }
        }

        if (best && bestScore >= 0.60) {
            await prisma.specialtyServiceMapping.upsert({
                where: { vismedSpecialtyId_doctoraliaServiceId: { vismedSpecialtyId: spec.id, doctoraliaServiceId: best.id } },
                update: { matchType: bestScore >= 0.90 ? 'APPROXIMATE' : 'APPROXIMATE', confidenceScore: bestScore, isActive: true, requiresReview: bestScore < 0.85 },
                create: { vismedSpecialtyId: spec.id, doctoraliaServiceId: best.id, matchType: 'APPROXIMATE', confidenceScore: bestScore, isActive: true, requiresReview: bestScore < 0.85 }
            });
            console.log('OK ' + spec.name + ' -> ' + best.name + ' (score: ' + bestScore.toFixed(3) + ')');
            matched++;
        } else {
            console.log('XX ' + spec.name + ' (best: ' + (best ? best.name : 'N/A') + ', score: ' + bestScore.toFixed(3) + ')');
        }
    }

    console.log('\nMatched: ' + matched + ' / ' + unmapped.length);
    await prisma.$disconnect();
}

importAndMap().catch(console.error);
