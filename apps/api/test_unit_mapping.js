const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const clinicId = '36749174-fb55-4ef6-94de-2f24ea97dc57';
    
    // First, try to find a mapping that ALREADY has both linked (VisMed + Doctoralia)
    const units = await prisma.vismedUnit.findMany({
        include: {
            doctors: {
                select: { id: true, name: true, isActive: true }
            }
        },
        orderBy: { name: 'asc' }
    });

    const results = await Promise.all(units.map(async (u) => {
        let m = await prisma.mapping.findFirst({
            where: { clinicId, entityType: 'LOCATION', vismedId: u.id, externalId: { not: null } }
        });

        console.log(`Unit: ${u.name} (${u.id}), Current Mapping: ${m ? 'Found (' + m.id + ')' : 'Not Found'}`);

        if (!m) {
            const doctoraliaMapping = await prisma.mapping.findFirst({
                where: {
                    clinicId,
                    entityType: 'LOCATION',
                    vismedId: null,
                    externalId: { not: null },
                    status: 'UNLINKED'
                }
            });

            console.log(`Orphan Mapping: ${doctoraliaMapping ? 'Found (' + doctoraliaMapping.id + ')' : 'Not Found'}`);

            if (doctoraliaMapping) {
                const dummyVismedMapping = await prisma.mapping.findFirst({
                    where: { clinicId, entityType: 'LOCATION', vismedId: u.id, externalId: null }
                });

                console.log(`Dummy Mapping to delete: ${dummyVismedMapping ? 'Found (' + dummyVismedMapping.id + ')' : 'Not Found'}`);

                if (dummyVismedMapping) {
                   await prisma.mapping.delete({ where: { id: dummyVismedMapping.id } });
                }

                m = await prisma.mapping.update({
                    where: { id: doctoraliaMapping.id },
                    data: {
                        vismedId: u.id,
                        status: 'LINKED'
                    }
                });
                console.log(`Linked successfully to mapping ${m.id}`);
            } else {
                m = await prisma.mapping.findFirst({
                    where: { clinicId, entityType: 'LOCATION', vismedId: u.id, externalId: null }
                });
                console.log(`Fallback to dummy mapping: ${m ? 'Found (' + m.id + ')' : 'Not Found'}`);
            }
        }

        const cd = m?.conflictData || {};

        return {
            name: u.name,
            doctoraliaCounterpart: m?.externalId ? {
                name: cd.name || u.name,
                externalId: m.externalId,
                status: m.status
            } : null
        };
    }));

    console.log('Final Results:', JSON.stringify(results, null, 2));
    process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
