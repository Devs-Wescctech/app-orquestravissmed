const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    console.log('=== ESPECIALIDADES VISMED ===\n');
    const vmSpecs = await prisma.vismedSpecialty.findMany({
        include: {
            mappings: {
                where: { isActive: true },
                include: { doctoraliaService: true }
            }
        }
    });
    vmSpecs.forEach(s => {
        const mapped = s.mappings.length > 0;
        console.log(`  ${mapped ? '✅' : '❌'} ${s.name} (ID: ${s.id}) ${mapped ? '→ ' + s.mappings[0].doctoraliaService.name : ''}`);
    });

    console.log('\n=== SERVIÇOS DOCTORALIA ===\n');
    const dcServices = await prisma.doctoraliaService.findMany({ take: 30, orderBy: { name: 'asc' } });
    dcServices.forEach(s => {
        console.log(`  🔵 ${s.name} (doctoraliaId: ${s.doctoraliaServiceId})`);
    });

    console.log('\n=== TABELA DE MAPEAMENTOS (SpecialtyServiceMapping) ===\n');
    const mappings = await prisma.specialtyServiceMapping.findMany({
        include: {
            vismedSpecialty: true,
            doctoraliaService: true
        }
    });
    if (mappings.length === 0) {
        console.log('  ⚠️ NENHUM MAPEAMENTO de Especialidade ↔ Serviço encontrado!');
        console.log('  ℹ️ A engine de Push de Serviços depende dessa tabela para saber o que adicionar/remover.');
        console.log('  ℹ️ Rode o Matching Engine ou crie mapeamentos manualmente no Mapping Hub.');
    } else {
        mappings.forEach(m => {
            console.log(`  ${m.isActive ? '✅' : '❌'} ${m.vismedSpecialty.name} ↔ ${m.doctoraliaService.name} (active: ${m.isActive}, match: ${m.matchType}, conf: ${m.confidenceScore})`);
        });
    }

    await prisma.$disconnect();
}

check().catch(console.error);
