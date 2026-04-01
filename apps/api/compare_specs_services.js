const { PrismaClient } = require('@prisma/client');
const stringSimilarity = require('string-similarity');
const prisma = new PrismaClient();

function normalize(str) {
    if (!str) return '';
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

async function check() {
    const vmSpecs = await prisma.vismedSpecialty.findMany({ orderBy: { name: 'asc' } });
    const dcServices = await prisma.doctoraliaService.findMany({ orderBy: { name: 'asc' } });

    console.log(`Total Especialidades VisMed: ${vmSpecs.length}`);
    console.log(`Total Serviços Doctoralia: ${dcServices.length}\n`);

    console.log('=== COMPARAÇÃO DETALHADA ===\n');

    for (const spec of vmSpecs) {
        const normSpec = normalize(spec.name);
        let bestMatch = null;
        let bestScore = 0;

        for (const svc of dcServices) {
            const score = stringSimilarity.compareTwoStrings(normSpec, normalize(svc.name));
            if (score > bestScore) {
                bestScore = score;
                bestMatch = svc;
            }
        }

        const icon = bestScore >= 0.85 ? '✅' : bestScore >= 0.60 ? '🟡' : '❌';
        console.log(`${icon} ${spec.name}`);
        console.log(`   Melhor candidato: "${bestMatch ? bestMatch.name : 'N/A'}" (score: ${bestScore.toFixed(3)})`);
        console.log('');
    }

    console.log('\n=== TODOS OS SERVIÇOS DOCTORALIA ===\n');
    dcServices.forEach(s => console.log(`  - ${s.name}`));

    await prisma.$disconnect();
}

check().catch(console.error);
