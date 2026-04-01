import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const hashedPassword = await bcrypt.hash('admin123', 10);

    // 1. Create Clinic 1 (Main)
    let clinic1 = await prisma.clinic.findFirst({ where: { name: 'VisMed Central Clinic' } });
    if (!clinic1) {
        clinic1 = await prisma.clinic.create({
            data: {
                name: 'VisMed Central Clinic',
                cnpj: '12.345.678/0001-99',
                timezone: 'America/Sao_Paulo',
                active: true,
            }
        });
    }
    console.log('Clinic 1 ready:', clinic1.id, clinic1.name);

    // 2. Create Clinic 2 (Secondary - for multi-clinic testing)
    let clinic2 = await prisma.clinic.findFirst({ where: { name: 'VisMed Unidade Sul' } });
    if (!clinic2) {
        clinic2 = await prisma.clinic.create({
            data: {
                name: 'VisMed Unidade Sul',
                cnpj: '98.765.432/0001-11',
                timezone: 'America/Sao_Paulo',
                active: true,
            }
        });
    }
    console.log('Clinic 2 ready:', clinic2.id, clinic2.name);

    // 3. Create Admin User
    const user = await prisma.user.upsert({
        where: { email: 'admin@vismed.com' },
        update: {},
        create: {
            email: 'admin@vismed.com',
            name: 'Admin VisMed',
            password: hashedPassword,
            active: true,
        },
    });
    console.log('Admin user created/verified:', user.email);

    // 4. Link admin to both clinics as SUPER_ADMIN
    await prisma.userClinicRole.upsert({
        where: { userId_clinicId: { userId: user.id, clinicId: clinic1.id } },
        update: { role: 'SUPER_ADMIN' },
        create: { userId: user.id, clinicId: clinic1.id, role: 'SUPER_ADMIN' },
    });
    await prisma.userClinicRole.upsert({
        where: { userId_clinicId: { userId: user.id, clinicId: clinic2.id } },
        update: { role: 'SUPER_ADMIN' },
        create: { userId: user.id, clinicId: clinic2.id, role: 'SUPER_ADMIN' },
    });
    console.log('Admin linked to both clinics as SUPER_ADMIN.');

    // 5. Setup Doctoralia Integration for Clinic 1 only
    const integration = await prisma.integrationConnection.findFirst({
        where: { clinicId: clinic1.id, provider: 'doctoralia' }
    });
    if (!integration) {
        await prisma.integrationConnection.create({
            data: {
                clinicId: clinic1.id,
                domain: 'doctoralia.com.br',
                provider: 'doctoralia',
                clientId: '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck',
                clientSecret: '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4',
                status: 'connected',
                lastTestAt: new Date()
            }
        });
        console.log('Doctoralia integration configured for Clinic 1.');
    }

    console.log('Seed complete!');
    console.log('- 2 clinics created');
    console.log('- Admin linked to both as SUPER_ADMIN');
    console.log('- Doctoralia integration on Clinic 1');
    console.log('- Login: admin@vismed.com / admin123');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
