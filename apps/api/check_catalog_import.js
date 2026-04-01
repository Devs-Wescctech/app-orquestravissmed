const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    // Check service catalog import logs
    const catalogEvents = await prisma.syncEvent.findMany({
        where: { entityType: 'SERVICE_CATALOG' },
        orderBy: { timestamp: 'desc' },
        take: 5
    });

    console.log('=== LOGS de importação do catálogo ===');
    if (catalogEvents.length === 0) {
        console.log('Nenhum evento SERVICE_CATALOG encontrado - o sync pode não ter rodado a etapa 3.5 ainda');
    }
    catalogEvents.forEach(e => {
        console.log(e.action + ': ' + e.message);
    });

    // List the 2 active mappings
    console.log('\n=== MAPEAMENTOS ATIVOS ===');
    const maps = await prisma.specialtyServiceMapping.findMany({
        where: { isActive: true },
        include: { vismedSpecialty: true, doctoraliaService: true }
    });
    maps.forEach(m => {
        console.log(m.vismedSpecialty.name + ' -> ' + m.doctoraliaService.name + ' (score: ' + m.confidenceScore + ', match: ' + m.matchType + ')');
    });

    await prisma.$disconnect();
}

check().catch(console.error);
