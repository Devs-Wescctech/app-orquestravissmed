const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    console.log('=== MÉDICOS PAREADOS E SUAS ESPECIALIDADES ===\n');
    const mappings = await prisma.professionalUnifiedMapping.findMany({
        where: { isActive: true },
        include: {
            vismedDoctor: {
                include: {
                    specialties: {
                        include: {
                            specialty: {
                                include: {
                                    mappings: {
                                        where: { isActive: true },
                                        include: { doctoraliaService: true }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            doctoraliaDoctor: true
        }
    });

    for (const m of mappings) {
        const vDoc = m.vismedDoctor;
        const dDoc = m.doctoraliaDoctor;
        console.log('Doctor: ' + vDoc.name + ' <-> ' + dDoc.name);

        if (vDoc.specialties.length === 0) {
            console.log('   SEM ESPECIALIDADES na VisMed');
        }

        for (const vs of vDoc.specialties) {
            const spec = vs.specialty;
            const hasMapping = spec.mappings && spec.mappings.length > 0;
            const dSvc = hasMapping ? spec.mappings[0].doctoraliaService : null;
            console.log('   ' + (hasMapping ? 'OK' : 'XX') + ' ' + spec.name + (hasMapping ? ' -> ' + dSvc.name + ' (doctoraliaId: ' + dSvc.doctoraliaServiceId + ')' : ''));
        }
        console.log('');
    }

    console.log('\n=== TOTAL MAPEAMENTOS SpecialtyServiceMapping ===');
    const total = await prisma.specialtyServiceMapping.count();
    const active = await prisma.specialtyServiceMapping.count({ where: { isActive: true } });
    console.log('Total: ' + total + ', Ativos: ' + active);

    console.log('\n=== TOTAL SERVIÇOS DoctoraliaService ===');
    const svcCount = await prisma.doctoraliaService.count();
    console.log('Total no banco: ' + svcCount);

    await prisma.$disconnect();
}

check().catch(console.error);
