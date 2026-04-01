const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Fetching all Vismed Doctors...');
    const vDocs = await prisma.vismedDoctor.findMany();
    console.log(`Found ${vDocs.length} doctors.`);

    // We can't easily instantiate the NestJS service here, 
    // but we can manually perform the same logic for this one-off fix.
    
    const dDocs = await prisma.doctoraliaDoctor.findMany();
    console.log(`Found ${dDocs.length} Doctoralia doctors.`);

    function normalize(str) {
        if (!str) return '';
        return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    }

    for (const v of vDocs) {
        const normV = normalize(v.name);
        const match = dDocs.find(d => normalize(d.name) === normV);
        
        if (match) {
            console.log(`Found match: ${v.name} <-> ${match.name}`);
            
            // 1. Unified Mapping
            await prisma.professionalUnifiedMapping.upsert({
                where: { vismedDoctorId_doctoraliaDoctorId: { vismedDoctorId: v.id, doctoraliaDoctorId: match.id } },
                update: { isActive: true },
                create: { vismedDoctorId: v.id, doctoraliaDoctorId: match.id, isActive: true }
            });

            // 2. Generic Mapping reconciliation
            const extId = String(match.doctoraliaDoctorId);
            const mappings = await prisma.mapping.findMany({
                where: { entityType: 'DOCTOR', externalId: extId }
            });

            for (const map of mappings) {
                const competing = await prisma.mapping.findFirst({
                    where: { clinicId: map.clinicId, entityType: 'DOCTOR', vismedId: v.id, id: { not: map.id } }
                });
                if (competing) {
                    await prisma.mapping.delete({ where: { id: competing.id } });
                    console.log(`  Deleting competing mapping for clinic ${map.clinicId}`);
                }
                await prisma.mapping.update({
                    where: { id: map.id },
                    data: { vismedId: v.id, status: 'LINKED' }
                });
                console.log(`  Updated mapping for clinic ${map.clinicId} to LINKED`);
            }
        }
    }
    console.log('Reconciliation complete.');
}

main().finally(() => prisma.$disconnect());
