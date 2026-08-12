'use strict';
/**
 * Seed do banco de teste a partir do dataset sintético (Prisma Client com
 * datasourceUrl apontando SOMENTE para o Postgres de teste).
 * Cria: clínicas, conexões (apontando p/ os mocks), entidades VisMed/Doctoralia,
 * mapeamentos LINKED, vínculos de especialidade e usuário SUPER_ADMIN.
 */
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

async function seedDatabase(databaseUrl, dataset) {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
        const passwordHash = await bcrypt.hash(dataset.superAdmin.password, 10);
        const admin = await prisma.user.create({
            data: { email: dataset.superAdmin.email, name: 'LoadTest Admin', password: passwordHash },
        });

        for (const c of dataset.clinics) {
            await prisma.clinic.create({ data: { id: c.id, name: c.name, timezone: 'America/Sao_Paulo' } });
            await prisma.userClinicRole.create({ data: { userId: admin.id, clinicId: c.id, role: 'SUPER_ADMIN' } });

            await prisma.integrationConnection.create({
                data: {
                    clinicId: c.id, provider: 'doctoralia', domain: c.doctoralia.domain,
                    facilityId: c.facilityId, clientId: c.doctoralia.clientId,
                    clientSecret: c.doctoralia.clientSecret, status: 'connected',
                },
            });
            await prisma.integrationConnection.create({
                data: {
                    clinicId: c.id, provider: 'vismed', domain: c.vismed.domain,
                    clientId: c.vismed.clientId, status: 'connected',
                },
            });

            const unit = await prisma.vismedUnit.create({
                data: {
                    vismedId: c.unit.vismedId, codUnidade: c.unit.codUnidade,
                    name: c.unit.name, cnpj: c.unit.cnpj, cityName: c.unit.cityName,
                },
            });

            const specIdByVismedId = new Map();
            for (const s of c.specialties) {
                const spec = await prisma.vismedSpecialty.upsert({
                    where: { vismedId: s.vismedId },
                    update: {},
                    create: { vismedId: s.vismedId, name: s.name, normalizedName: s.name.toLowerCase() },
                });
                specIdByVismedId.set(s.vismedId, spec.id);
            }
            for (const i of c.insurances) {
                await prisma.vismedInsurance.upsert({
                    where: { vismedId: i.vismedId },
                    update: {},
                    create: { vismedId: i.vismedId, name: i.name },
                });
            }

            for (const d of c.doctors) {
                const vd = await prisma.vismedDoctor.create({
                    data: {
                        vismedId: d.vismedId, name: d.name, formalName: d.formalName,
                        cpf: d.cpf, documentNumber: d.crm, documentType: 'CRM',
                        gender: d.gender, unitId: unit.id, turnoM: d.turnoM, turnoT: d.turnoT,
                    },
                });
                const specId = specIdByVismedId.get(d.specialtyVismedId);
                if (specId) {
                    await prisma.vismedProfessionalSpecialty.create({
                        data: { vismedDoctorId: vd.id, vismedSpecialtyId: specId, source: 'SYNC' },
                    });
                }
                const dd = await prisma.doctoraliaDoctor.create({
                    data: {
                        doctoraliaDoctorId: d.doctoraliaDoctorId,
                        doctoraliaFacilityId: c.facilityId,
                        name: d.name,
                    },
                });
                await prisma.professionalUnifiedMapping.create({
                    data: { vismedDoctorId: vd.id, doctoraliaDoctorId: dd.id, isActive: true },
                });
                await prisma.mapping.create({
                    data: {
                        clinicId: c.id, entityType: 'DOCTOR',
                        vismedId: String(d.vismedId), externalId: d.doctoraliaDoctorId,
                        status: 'LINKED',
                    },
                });
            }
        }
    } finally {
        await prisma.$disconnect();
    }
}

/** Lê as conexões do banco de teste (para o guard anti-produção). */
async function readConnections(databaseUrl) {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
        return await prisma.integrationConnection.findMany({
            select: { clinicId: true, provider: true, domain: true },
        });
    } finally {
        await prisma.$disconnect();
    }
}

/** Consulta SyncRuns (para o runner aguardar términos). */
async function readSyncRuns(databaseUrl) {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
        return await prisma.syncRun.findMany({
            select: { id: true, clinicId: true, type: true, status: true, startedAt: true, endedAt: true },
            orderBy: { startedAt: 'asc' },
        });
    } finally {
        await prisma.$disconnect();
    }
}

module.exports = { seedDatabase, readConnections, readSyncRuns };
