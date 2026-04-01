const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function seedMappings() {
    try {
        console.log('Seeding MVP Mapping data...');

        // 1. Get the first clinic
        const clinic = await prisma.clinic.findFirst();
        if (!clinic) {
            console.error('No clinic found. Run standard seed first.');
            return;
        }

        // 2. Create Dummy Docs
        const doc1 = await prisma.doctor.create({
            data: { name: 'Dr. Sarah Jenkins', specialty: 'Cardiology', crm: '123456', email: 'sarah@vismed.com' }
        });
        const doc2 = await prisma.doctor.create({
            data: { name: 'Dr. Robert Liu', specialty: 'Pediatrics', crm: '654321', email: 'robert@vismed.com' }
        });
        const doc3 = await prisma.doctor.create({
            data: { name: 'Dr. Emily White', specialty: 'Dermatology', crm: '987654', email: 'emily@vismed.com' }
        });

        // 3. Create Mappings for these docs
        // Linked Doc
        await prisma.mapping.create({
            data: {
                clinicId: clinic.id,
                entityType: 'DOCTOR',
                vismedId: doc1.id,
                externalId: 'da-331',
                status: 'LINKED',
                lastSyncAt: new Date()
            }
        });

        // Conflict Doc
        await prisma.mapping.create({
            data: {
                clinicId: clinic.id,
                entityType: 'DOCTOR',
                vismedId: doc2.id,
                externalId: 'da-224',
                status: 'CONFLICT',
                conflictData: {
                    vismedData: { phone: '+1 (555) 123-4567', email: 'r.liu@vismed.com' },
                    externalData: { phone: '+1 (555) 987-6543', email: 'robert@alia.com' }
                }
            }
        });

        // Unlinked Doc
        await prisma.mapping.create({
            data: {
                clinicId: clinic.id,
                entityType: 'DOCTOR',
                vismedId: doc3.id,
                externalId: null,
                status: 'UNLINKED'
            }
        });

        // Add some dummy Services
        const serv1 = await prisma.service.create({ data: { name: 'Cardiology Consult', duration: 30, price: 150 } });
        await prisma.mapping.create({
            data: {
                clinicId: clinic.id,
                entityType: 'SERVICE',
                vismedId: serv1.id,
                externalId: 'srv-1',
                status: 'LINKED'
            }
        });

        console.log('Mapping seed completed gracefully.');
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

seedMappings();
