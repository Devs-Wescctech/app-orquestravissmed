import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MappingEntityType, Prisma } from '@prisma/client';

@Injectable()
export class MappingsService {
    constructor(private prisma: PrismaService) { }

    async findAll(clinicId: string, entityType?: MappingEntityType) {
        const whereClause: any = { clinicId };
        if (entityType) {
            whereClause.entityType = entityType;
        }

        // Attempt retrieval
        let mappings = await this.prisma.mapping.findMany({
            where: whereClause,
            orderBy: { updatedAt: 'desc' },
        });



        // Add Vismed Context for frontend render
        return Promise.all(mappings.map(async (m) => {
            let vismedData = null;
            if (m.vismedId) {
                if (m.entityType === 'DOCTOR') {
                    vismedData = await this.prisma.vismedDoctor.findUnique({ where: { id: m.vismedId } });
                } else if (m.entityType === 'SERVICE') {
                    vismedData = await this.prisma.vismedSpecialty.findUnique({ where: { id: m.vismedId } });
                } else if (m.entityType === 'LOCATION') {
                    vismedData = await this.prisma.vismedUnit.findUnique({ where: { id: m.vismedId } });
                }
            }
            return { ...m, vismedEntity: vismedData };
        }));
    }

    async resolveConflict(id: string, dataToKeep: 'VISMED' | 'EXTERNAL', userId?: string) {
        const mapping = await this.prisma.mapping.findUnique({ where: { id } });
        if (!mapping || mapping.status !== 'CONFLICT') {
            throw new Error('Mapping is not in a manageable conflict state.');
        }

        const cd = mapping.conflictData as any || {};
        const resolutionDetails = {
            resolvedAt: new Date(),
            resolvedBy: userId,
            dataToKeep,
            previousData: cd
        };

        // Audit resolution
        await this.prisma.auditLog.create({
            data: {
                userId,
                action: 'RESOLVE_MAPPING_CONFLICT',
                entity: 'MAPPING',
                entityId: id,
                details: resolutionDetails as any,
            }
        });

        // Overwrite behavior logic resolves the conflict flag
        return this.prisma.mapping.update({
            where: { id },
            data: {
                status: 'LINKED',
                conflictData: Prisma.JsonNull,
                lastSyncAt: new Date(),
            }
        });
    }

    /**
     * Ensures that a VisMed ID is not already mapped to another external record
     * maintains 1:1 relationship per clinic.
     */
    async validateUniqueness(clinicId: string, entityType: MappingEntityType, vismedId: string, excludeMappingId?: string) {
        const existing = await this.prisma.mapping.findFirst({
            where: {
                clinicId,
                entityType,
                vismedId,
                id: excludeMappingId ? { not: excludeMappingId } : undefined,
                status: { in: ['LINKED', 'CONFLICT'] }
            }
        });

        if (existing) {
            throw new Error(`Este item do VisMed já está vinculado a outro registro da Doctoralia (${existing.externalId}).`);
        }
    }

    // ------------------------------------------------------------------------------------------
    // NOVO MODELO RELACIONAL — Profissionais vinculados a Especialidades
    // ------------------------------------------------------------------------------------------

    async getProfessionalMappings(clinicId: string) {
        // Get all genetic mappings for DOCTOR for this clinic first
        const genericMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' }
        });
        const mappingMap = new Map<string, any>();
        genericMappings.forEach(m => {
            if (m.vismedId) mappingMap.set(m.vismedId, m);
            if (m.externalId) mappingMap.set(m.externalId, m);
        });

        const doctors = await this.prisma.vismedDoctor.findMany({
            include: {
                unit: true,
                specialties: {
                    include: {
                        specialty: {
                            include: {
                                mappings: {
                                    where: { isActive: true },
                                    include: { doctoraliaService: true },
                                    take: 1
                                }
                            }
                        }
                    }
                },
                unifiedMappings: {
                    where: { isActive: true },
                    include: {
                        doctoraliaDoctor: {
                            include: {
                                addressServices: {
                                    include: { service: true },
                                    take: 5
                                }
                            }
                        }
                    }
                }
            },
            orderBy: { name: 'asc' }
        });

        return doctors.map(d => {
            const externalId = d.unifiedMappings[0]?.doctoraliaDoctor?.doctoraliaDoctorId;
            const m = mappingMap.get(d.id) || (externalId ? mappingMap.get(externalId) : null);
            const cd = m?.conflictData as any || {};
            const doctoraliaDoctorIdFromMapping = m?.externalId;

            return {
                id: d.id,
                vismedId: d.vismedId,
                name: d.name,
                formalName: d.formalName,
                documentNumber: d.documentNumber,
                documentType: d.documentType,
                gender: d.gender,
                isActive: d.isActive,
                unit: d.unit ? { name: d.unit.name, city: d.unit.cityName } : null,
                specialties: d.specialties.map(ps => ({
                    id: ps.specialty.id,
                    name: ps.specialty.name,
                    normalizedName: ps.specialty.normalizedName,
                    activeMatch: ps.specialty.mappings[0] ? {
                        matchType: (ps.specialty.mappings[0] as any).matchType,
                        confidenceScore: (ps.specialty.mappings[0] as any).confidenceScore,
                        requiresReview: (ps.specialty.mappings[0] as any).requiresReview,
                        doctoraliaService: (ps.specialty.mappings[0] as any).doctoraliaService?.name
                    } : null
                })),
                doctoraliaCounterpart: d.unifiedMappings[0]?.doctoraliaDoctor ? {
                    name: d.unifiedMappings[0].doctoraliaDoctor.name,
                    doctoraliaDoctorId: d.unifiedMappings[0].doctoraliaDoctor.doctoraliaDoctorId,
                    calendarStatus: cd.calendarStatus || 'disabled', // Getting from mapping
                    services: d.unifiedMappings[0].doctoraliaDoctor.addressServices.map(as => as.service?.name).filter(Boolean)
                } : (doctoraliaDoctorIdFromMapping ? {
                    name: cd.name || d.name,
                    doctoraliaDoctorId: doctoraliaDoctorIdFromMapping,
                    calendarStatus: cd.calendarStatus || 'disabled',
                    services: []
                } : null)
            };
        });
    }

    async getUnitMappings(clinicId: string) {
        const units = await this.prisma.vismedUnit.findMany({
            include: {
                doctors: {
                    select: { id: true, name: true, isActive: true }
                }
            },
            orderBy: { name: 'asc' }
        });

        return Promise.all(units.map(async (u) => {
            // First, try to find a mapping that ALREADY has both linked (VisMed + Doctoralia)
            let m = await this.prisma.mapping.findFirst({
                where: { clinicId, entityType: 'LOCATION', vismedId: u.id, externalId: { not: null } }
            });

            // If not found, check if we have an empty VisMed mapping AND an orphan Doctoralia mapping to merge
            if (!m) {
                const doctoraliaMapping = await this.prisma.mapping.findFirst({
                    where: {
                        clinicId,
                        entityType: 'LOCATION',
                        vismedId: null,
                        externalId: { not: null },
                        status: 'UNLINKED'
                    }
                });

                if (doctoraliaMapping) {
                    // We found a Doctoralia record! Now check if we have a dummy VisMed-only record to clean up
                    const dummyVismedMapping = await this.prisma.mapping.findFirst({
                        where: { clinicId, entityType: 'LOCATION', vismedId: u.id, externalId: null }
                    });

                    if (dummyVismedMapping) {
                        try {
                            await this.prisma.mapping.delete({ where: { id: dummyVismedMapping.id } });
                        } catch (e) {
                            // If delete fails (e.g. race condition), we ignore and move on
                            console.error('Failed to cleanup dummy mapping:', e);
                        }
                    }

                    // Perform the link
                    m = await this.prisma.mapping.update({
                        where: { id: doctoraliaMapping.id },
                        data: {
                            vismedId: u.id,
                            status: 'LINKED'
                        }
                    });
                } else {
                    // Fallback to the VisMed-only record if it exists
                    m = await this.prisma.mapping.findFirst({
                        where: { clinicId, entityType: 'LOCATION', vismedId: u.id, externalId: null }
                    });
                }
            }

            const cd = m?.conflictData as any || {};

            return {
                id: u.id,
                vismedId: u.vismedId,
                name: u.name,
                cityName: u.cityName,
                cnpj: u.cnpj,
                isActive: u.isActive,
                doctorCount: u.doctors.length,
                doctors: u.doctors,
                doctoraliaCounterpart: m?.externalId ? {
                    name: cd.name || u.name,
                    externalId: m.externalId,
                    status: m.status
                } : null
            };
        }));
    }

    // ------------------------------------------------------------------------------------------
    // NEW MATCHING ENGINE ENDPOINTS (SPRINT 6)
    // ------------------------------------------------------------------------------------------

    async getSpecialtyMatches(requiresReview?: boolean) {
        const whereClause: any = { isActive: true };
        if (requiresReview !== undefined) {
            whereClause.requiresReview = requiresReview;
        }

        return this.prisma.specialtyServiceMapping.findMany({
            where: whereClause,
            include: {
                vismedSpecialty: true,
                doctoraliaService: true
            },
            orderBy: { confidenceScore: 'desc' }
        });
    }

    async approveSpecialtyMatch(vismedSpecialtyId: string, doctoraliaServiceId: string, userId?: string) {
        const mapping = await this.prisma.specialtyServiceMapping.update({
            where: {
                vismedSpecialtyId_doctoraliaServiceId: {
                    vismedSpecialtyId,
                    doctoraliaServiceId
                }
            },
            data: { requiresReview: false }
        });

        if (userId) {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: 'APPROVE_SPECIALTY_MATCH',
                    entity: 'SPECIALTY_MAPPING',
                    entityId: `${vismedSpecialtyId}_${doctoraliaServiceId}`,
                    details: { previousState: 'REQUIRES_REVIEW', newState: 'APPROVED' } as any,
                }
            });
        }
        return mapping;
    }

    async rejectSpecialtyMatch(vismedSpecialtyId: string, doctoraliaServiceId: string, userId?: string) {
        // We reject by setting isActive to false. This allows the system to remember
        // this exact pairing was rejected, preventing the engine from auto-matching it again in the future.
        const mapping = await this.prisma.specialtyServiceMapping.update({
            where: {
                vismedSpecialtyId_doctoraliaServiceId: {
                    vismedSpecialtyId,
                    doctoraliaServiceId
                }
            },
            data: { isActive: false, requiresReview: false }
        });

        if (userId) {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: 'REJECT_SPECIALTY_MATCH',
                    entity: 'SPECIALTY_MAPPING',
                    entityId: `${vismedSpecialtyId}_${doctoraliaServiceId}`,
                    details: { reason: 'MANUAL_REJECTION' } as any,
                }
            });
        }
        return mapping;
    }

    async createManualSpecialtyMatch(vismedSpecialtyId: string, doctoraliaServiceId: string, userId?: string) {
        // First, invalidate any previous active mappings for this VismedSpecialty
        await this.prisma.specialtyServiceMapping.updateMany({
            where: { vismedSpecialtyId, isActive: true },
            data: { isActive: false }
        });

        // Upsert the new manual match
        const mapping = await this.prisma.specialtyServiceMapping.upsert({
            where: {
                vismedSpecialtyId_doctoraliaServiceId: {
                    vismedSpecialtyId,
                    doctoraliaServiceId
                }
            },
            update: {
                matchType: 'MANUAL',
                confidenceScore: 1.0,
                requiresReview: false,
                isActive: true
            },
            create: {
                vismedSpecialtyId,
                doctoraliaServiceId,
                matchType: 'MANUAL',
                confidenceScore: 1.0,
                requiresReview: false,
                isActive: true
            }
        });

        if (userId) {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: 'CREATE_MANUAL_SPECIALTY_MATCH',
                    entity: 'SPECIALTY_MAPPING',
                    entityId: `${vismedSpecialtyId}_${doctoraliaServiceId}`,
                    details: { source: 'MANUAL_OVERRIDE' } as any,
                }
            });
        }
        return mapping;
    }
}
