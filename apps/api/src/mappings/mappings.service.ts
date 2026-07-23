import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
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



        return Promise.all(mappings.map(async (m) => {
            let vismedData = null;
            let doctoraliaCounterpart = null;

            if (m.vismedId) {
                if (m.entityType === 'DOCTOR') {
                    vismedData = await this.prisma.vismedDoctor.findUnique({ where: { id: m.vismedId } });
                } else if (m.entityType === 'SERVICE') {
                    vismedData = await this.prisma.vismedSpecialty.findUnique({ where: { id: m.vismedId } });
                } else if (m.entityType === 'LOCATION') {
                    vismedData = await this.prisma.vismedUnit.findUnique({ where: { id: m.vismedId } });
                } else if (m.entityType === 'INSURANCE') {
                    vismedData = await this.prisma.vismedInsurance.findUnique({ where: { id: m.vismedId } });
                }
            }

            if (m.entityType === 'INSURANCE' && m.externalId) {
                const dip = await this.prisma.doctoraliaInsuranceProvider.findFirst({
                    where: { doctoraliaId: Number(m.externalId) }
                });
                if (dip) {
                    doctoraliaCounterpart = {
                        doctoraliaId: dip.doctoraliaId,
                        name: dip.name,
                    };
                }
            }

            return { ...m, vismedEntity: vismedData, doctoraliaCounterpart };
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
        const genericMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' }
        });
        const mappingMap = new Map<string, any>();
        const clinicVismedDoctorIds: string[] = [];
        genericMappings.forEach(m => {
            if (m.vismedId) {
                mappingMap.set(m.vismedId, m);
                clinicVismedDoctorIds.push(m.vismedId);
            }
            if (m.externalId) mappingMap.set(m.externalId, m);
        });

        const doctors = await this.prisma.vismedDoctor.findMany({
            where: { id: { in: clinicVismedDoctorIds } },
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
                turnos: {
                    turnoM: d.turnoM || null,
                    turnoT: d.turnoT || null,
                    turnoN: d.turnoN || null,
                },
                specialties: (() => {
                    const seen = new Set<string>();
                    return d.specialties
                        .map(ps => ({
                            id: ps.specialty.id,
                            name: ps.specialty.name,
                            normalizedName: ps.specialty.normalizedName,
                            activeMatch: ps.specialty.mappings[0] ? {
                                matchType: (ps.specialty.mappings[0] as any).matchType,
                                confidenceScore: (ps.specialty.mappings[0] as any).confidenceScore,
                                requiresReview: (ps.specialty.mappings[0] as any).requiresReview,
                                invalidReason: (ps.specialty.mappings[0] as any).invalidReason,
                                doctoraliaService: (ps.specialty.mappings[0] as any).doctoraliaService?.name
                            } : null
                        }))
                        .filter(s => {
                            const key = s.normalizedName || s.name.toLowerCase();
                            if (seen.has(key)) return false;
                            seen.add(key);
                            return true;
                        });
                })(),
                doctoraliaCounterpart: d.unifiedMappings[0]?.doctoraliaDoctor ? {
                    name: d.unifiedMappings[0].doctoraliaDoctor.name,
                    doctoraliaDoctorId: d.unifiedMappings[0].doctoraliaDoctor.doctoraliaDoctorId,
                    calendarStatus: cd.calendarStatus || 'unknown',
                    services: d.unifiedMappings[0].doctoraliaDoctor.addressServices.map(as => as.service?.name).filter(Boolean)
                } : (doctoraliaDoctorIdFromMapping ? {
                    name: cd.name || d.name,
                    doctoraliaDoctorId: doctoraliaDoctorIdFromMapping,
                    calendarStatus: cd.calendarStatus || 'unknown',
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

    async searchCatalog(q: string, limit: number = 100) {
        const safeLimit = Math.min(Math.max(limit, 1), 500);
        const normalizedQ = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

        if (!normalizedQ) {
            return this.prisma.doctoraliaService.findMany({
                take: safeLimit,
                orderBy: { name: 'asc' },
                select: { id: true, doctoraliaServiceId: true, name: true, normalizedName: true }
            });
        }

        return this.prisma.doctoraliaService.findMany({
            where: {
                OR: [
                    { normalizedName: { contains: normalizedQ } },
                    { name: { contains: q, mode: 'insensitive' } },
                ]
            },
            take: safeLimit,
            orderBy: { name: 'asc' },
            select: { id: true, doctoraliaServiceId: true, name: true, normalizedName: true }
        });
    }

    async getCatalogStats() {
        const [totalServices, totalMapped, totalPendingReview] = await Promise.all([
            this.prisma.doctoraliaService.count(),
            this.prisma.specialtyServiceMapping.count({ where: { isActive: true, requiresReview: false } }),
            this.prisma.specialtyServiceMapping.count({ where: { isActive: true, requiresReview: true } }),
        ]);
        return { totalServices, totalMapped, totalPendingReview };
    }

    async getSpecialtyMatches(requiresReview?: boolean) {
        const whereClause: any = { isActive: true };
        if (requiresReview !== undefined) {
            whereClause.requiresReview = requiresReview;
        }

        const rows = await this.prisma.specialtyServiceMapping.findMany({
            where: whereClause,
            include: {
                vismedSpecialty: true,
                doctoraliaService: true
            },
            orderBy: { confidenceScore: 'desc' }
        });

        // DEDUP: especialidades VisMed duplicadas (mesmo normalizedName) geram mappings ativos
        // idênticos apontando para o mesmo serviço Doctoralia — a lista mostrava a mesma linha 2x.
        // Mantemos a primeira ocorrência (maior score, e dentro do empate a mais "resolvida":
        // aprovada antes de pendente).
        const seen = new Map<string, any>();
        for (const row of rows) {
            const specKey = row.vismedSpecialty?.normalizedName || row.vismedSpecialty?.name || row.vismedSpecialtyId;
            const key = `${specKey}::${row.doctoraliaServiceId}`;
            const existing = seen.get(key);
            if (!existing) {
                seen.set(key, row);
            } else if (existing.requiresReview && !row.requiresReview) {
                seen.set(key, row);
            }
        }
        return Array.from(seen.values());
    }

    async getSpecialtyStats() {
        const [totalVismed, totalDoctoralia, totalMatched, totalPendingReview, totalUnmatched] = await Promise.all([
            this.prisma.vismedSpecialty.count(),
            this.prisma.doctoraliaService.count(),
            this.prisma.specialtyServiceMapping.count({ where: { isActive: true, requiresReview: false } }),
            this.prisma.specialtyServiceMapping.count({ where: { isActive: true, requiresReview: true } }),
            this.prisma.vismedSpecialty.count({ where: { mappings: { none: { isActive: true } } } }),
        ]);
        const autoApproved = totalMatched;
        const totalMatchedAll = totalMatched + totalPendingReview;
        return {
            totalVismedSpecialties: totalVismed,
            totalDoctoraliaServices: totalDoctoralia,
            totalMatched: totalMatchedAll,
            totalAutoApproved: autoApproved,
            totalPendingReview,
            totalUnmatched,
            coveragePercent: totalVismed > 0 ? Math.round((totalMatchedAll / totalVismed) * 100) : 0,
        };
    }

    async approveSpecialtyMatch(vismedSpecialtyId: string, doctoraliaServiceId: string, userId?: string) {
        const existing = await this.prisma.specialtyServiceMapping.findUnique({
            where: {
                vismedSpecialtyId_doctoraliaServiceId: { vismedSpecialtyId, doctoraliaServiceId }
            }
        });
        if (!existing) {
            throw new NotFoundException('Mapeamento de especialidade não encontrado.');
        }

        // Se o service_id já foi REJEITADO pela Doctoralia (invalidReason preenchido), aprovar o
        // mesmo ID de novo entraria em loop: o push reenviaria, tomaria 404 e re-invalidaria.
        // Tratamos como OVERRIDE CONSCIENTE: aprova (sai da fila de pendentes), mas MANTÉM o
        // invalidReason visível e marca overrideInvalid=true — o push NÃO reenvia esse ID.
        const wasInvalid = !!existing.invalidReason;
        const mapping = await this.prisma.specialtyServiceMapping.update({
            where: {
                vismedSpecialtyId_doctoraliaServiceId: { vismedSpecialtyId, doctoraliaServiceId }
            },
            data: wasInvalid
                ? { requiresReview: false, matchType: 'MANUAL', overrideInvalid: true }
                : { requiresReview: false, matchType: 'MANUAL', invalidReason: null, invalidAt: null, overrideInvalid: false }
        });

        if (userId) {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: wasInvalid ? 'APPROVE_SPECIALTY_MATCH_OVERRIDE_INVALID' : 'APPROVE_SPECIALTY_MATCH',
                    entity: 'SPECIALTY_MAPPING',
                    entityId: `${vismedSpecialtyId}_${doctoraliaServiceId}`,
                    details: {
                        previousState: 'REQUIRES_REVIEW',
                        newState: wasInvalid ? 'APPROVED_WITH_OVERRIDE' : 'APPROVED',
                        ...(wasInvalid ? { invalidReason: existing.invalidReason } : {}),
                    } as any,
                }
            });
        }
        return {
            ...mapping,
            overrideWarning: wasInvalid
                ? 'Serviço já rejeitado pela Doctoralia: aprovado como override consciente. Este serviço NÃO será enviado à Doctoralia até ser remapeado para um serviço válido do catálogo da unidade.'
                : undefined,
        };
    }

    /**
     * Sugere serviços Doctoralia alternativos para remapear uma especialidade cujo mapping foi
     * invalidado. Prioriza serviços presentes no catálogo real das unidades (DoctoraliaAddressService)
     * e ordena por similaridade de nome com a especialidade.
     */
    async getSpecialtyRemapCandidates(vismedSpecialtyId: string) {
        const specialty = await this.prisma.vismedSpecialty.findUnique({ where: { id: vismedSpecialtyId } });
        if (!specialty) {
            throw new NotFoundException('Especialidade VisMed não encontrada.');
        }

        // Serviços que EXISTEM de fato em algum endereço sincronizado (catálogo real da unidade).
        const addressServices = await this.prisma.doctoraliaAddressService.findMany({
            select: { serviceId: true },
            distinct: ['serviceId'],
        });
        const catalogServiceUuids = new Set(addressServices.map(a => a.serviceId));

        const services = await this.prisma.doctoraliaService.findMany({
            select: { id: true, doctoraliaServiceId: true, name: true, normalizedName: true },
        });

        const norm = (s: string) => (s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const target = norm(specialty.normalizedName || specialty.name);
        const targetTokens = new Set(target.split(' ').filter(Boolean));

        const scored = services.map(svc => {
            const cand = norm(svc.normalizedName || svc.name);
            let score = 0;
            if (cand === target) score = 1;
            else if (cand.includes(target) || target.includes(cand)) score = 0.8;
            else {
                const candTokens = cand.split(' ').filter(Boolean);
                const common = candTokens.filter(t => targetTokens.has(t)).length;
                const total = Math.max(targetTokens.size, candTokens.length, 1);
                score = common / total;
            }
            return {
                doctoraliaServiceId: svc.id,
                dictServiceId: svc.doctoraliaServiceId,
                name: svc.name,
                score: Math.round(score * 100) / 100,
                inUnitCatalog: catalogServiceUuids.has(svc.id),
            };
        });

        const sorted = scored
            .filter(c => c.score > 0.1 || c.inUnitCatalog)
            .sort((a, b) => {
                if (a.inUnitCatalog !== b.inUnitCatalog) return a.inUnitCatalog ? -1 : 1;
                return b.score - a.score;
            });

        // Dedup por nome: o dicionário global tem serviços repetidos com o mesmo nome e dict_ids
        // diferentes; mostramos só o melhor de cada nome para não poluir o seletor.
        const byName = new Map<string, typeof sorted[number]>();
        for (const c of sorted) {
            const key = norm(c.name);
            if (!byName.has(key)) byName.set(key, c);
        }
        return Array.from(byName.values()).slice(0, 25);
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
                isActive: true,
                invalidReason: null,
                invalidAt: null,
                overrideInvalid: false
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

    async approveInsuranceMatch(mappingId: string, clinicId: string, userId?: string) {
        if (!mappingId) {
            throw new BadRequestException('mappingId é obrigatório.');
        }
        const mapping = await this.prisma.mapping.findFirst({
            where: { id: mappingId, clinicId, entityType: 'INSURANCE', status: 'PENDING_REVIEW' }
        });
        if (!mapping) {
            throw new NotFoundException('Mapeamento de convênio não encontrado ou não está pendente de revisão.');
        }

        const updated = await this.prisma.mapping.update({
            where: { id: mappingId },
            data: { status: 'LINKED' }
        });

        if (userId) {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: 'APPROVE_INSURANCE_MATCH',
                    entity: 'MAPPING',
                    entityId: mappingId,
                    details: { previousState: 'PENDING_REVIEW', newState: 'LINKED' } as any,
                }
            });
        }
        return updated;
    }

    async rejectInsuranceMatch(mappingId: string, clinicId: string, userId?: string) {
        if (!mappingId) {
            throw new BadRequestException('mappingId é obrigatório.');
        }
        const mapping = await this.prisma.mapping.findFirst({
            where: { id: mappingId, clinicId, entityType: 'INSURANCE', status: 'PENDING_REVIEW' }
        });
        if (!mapping) {
            throw new NotFoundException('Mapeamento de convênio não encontrado ou não está pendente de revisão.');
        }

        const updated = await this.prisma.mapping.update({
            where: { id: mappingId },
            data: { status: 'UNLINKED', externalId: null }
        });

        if (userId) {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: 'REJECT_INSURANCE_MATCH',
                    entity: 'MAPPING',
                    entityId: mappingId,
                    details: { reason: 'MANUAL_REJECTION' } as any,
                }
            });
        }
        return updated;
    }
}
