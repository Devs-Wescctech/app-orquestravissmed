const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    console.log('=== ÚLTIMOS EVENTOS DE PUSH (Serviços + Endereços) ===\n');

    const events = await prisma.syncEvent.findMany({
        where: {
            entityType: { in: ['ADDRESS_PUSH', 'SERVICE_PUSH'] }
        },
        orderBy: { timestamp: 'desc' },
        take: 20
    });

    const grouped = { ADDRESS_PUSH: [], SERVICE_PUSH: [] };
    events.forEach(e => {
        if (grouped[e.entityType]) grouped[e.entityType].push(e);
    });

    console.log(`📍 ADDRESS_PUSH: ${grouped.ADDRESS_PUSH.length} eventos`);
    grouped.ADDRESS_PUSH.forEach(e => {
        console.log(`   [${e.action.toUpperCase()}] ${e.message}`);
    });

    console.log(`\n🔧 SERVICE_PUSH: ${grouped.SERVICE_PUSH.length} eventos`);
    grouped.SERVICE_PUSH.forEach(e => {
        console.log(`   [${e.action.toUpperCase()}] ${e.message}`);
    });

    console.log('\n=== MAPEAMENTOS ATIVOS (Médicos Pareados) ===\n');
    const mappings = await prisma.professionalUnifiedMapping.findMany({
        where: { isActive: true },
        include: {
            vismedDoctor: {
                include: {
                    specialties: {
                        include: { specialty: { include: { mappings: { where: { isActive: true }, include: { doctoraliaService: true } } } } }
                    }
                }
            },
            doctoraliaDoctor: true
        }
    });

    console.log(`Total de médicos pareados ativos: ${mappings.length}\n`);

    for (const m of mappings) {
        const vDoc = m.vismedDoctor;
        const dDoc = m.doctoraliaDoctor;
        console.log(`👨‍⚕️ ${vDoc.name} (VisMed) ↔ ${dDoc.name} (Doctoralia)`);

        const specs = vDoc.specialties.map(vs => {
            const spec = vs.specialty;
            const mapped = spec.mappings && spec.mappings.length > 0;
            const dService = mapped ? spec.mappings[0].doctoraliaService : null;
            return `     - ${spec.name} → ${mapped ? dService.name + ' (ID: ' + dService.doctoraliaId + ')' : '⚠️ SEM MAPEAMENTO'}`;
        });

        if (specs.length === 0) {
            console.log('     ⚠️ Nenhuma especialidade vinculada no VisMed');
        } else {
            specs.forEach(s => console.log(s));
        }
        console.log('');
    }

    await prisma.$disconnect();
}

check().catch(console.error);
