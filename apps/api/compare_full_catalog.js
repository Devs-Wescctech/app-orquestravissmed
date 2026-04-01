const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const fs = require('fs');
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

    // Get full catalog
    const catRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/140548/services`, { headers });
    const catalog = await catRes.json();
    const services = catalog._items || [];

    console.log(`Total serviços no catálogo Doctoralia: ${services.length}\n`);

    // Get VisMed specialties
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const vmSpecs = await prisma.vismedSpecialty.findMany({ orderBy: { name: 'asc' } });

    console.log(`Total especialidades VisMed: ${vmSpecs.length}\n`);
    console.log('=== COMPARAÇÃO: Especialidades VisMed vs Catálogo Doctoralia ===\n');

    let matchCount = 0;
    const results = [];

    for (const spec of vmSpecs) {
        const normSpec = normalize(spec.name);
        let bestMatch = null;
        let bestScore = 0;

        for (const svc of services) {
            const score = stringSimilarity.compareTwoStrings(normSpec, normalize(svc.name));
            if (score > bestScore) {
                bestScore = score;
                bestMatch = svc;
            }
        }

        const icon = bestScore >= 0.85 ? '✅' : bestScore >= 0.60 ? '🟡' : '❌';
        if (bestScore >= 0.60) matchCount++;

        results.push({ spec: spec.name, match: bestMatch ? bestMatch.name : 'N/A', matchId: bestMatch ? bestMatch.id : null, score: bestScore });
        console.log(`${icon} ${spec.name}`);
        console.log(`   → "${bestMatch ? bestMatch.name : 'N/A'}" (ID: ${bestMatch ? bestMatch.id : '-'}, score: ${bestScore.toFixed(3)})`);
    }

    console.log(`\n=== RESUMO ===`);
    console.log(`Matches >= 0.85: ${results.filter(r => r.score >= 0.85).length}`);
    console.log(`Matches 0.60-0.84: ${results.filter(r => r.score >= 0.60 && r.score < 0.85).length}`);
    console.log(`Sem match (<0.60): ${results.filter(r => r.score < 0.60).length}`);

    await prisma.$disconnect();
}

analyze().catch(console.error);
