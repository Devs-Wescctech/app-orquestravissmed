import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as stringSimilarity from 'string-similarity';
import { MatchType } from '@prisma/client';

@Injectable()
export class MatchingEngineService {
    private readonly logger = new Logger(MatchingEngineService.name);

    constructor(private prisma: PrismaService) { }

    normalizeString(str: string): string {
        if (!str) return '';
        return str
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();
    }

    async runMatchingForSpecialty(vismedSpecialtyId: string): Promise<boolean> {
        const specialty = await this.prisma.vismedSpecialty.findUnique({
            where: { id: vismedSpecialtyId }
        });

        if (!specialty) return false;

        const normSpecialty = this.normalizeString(specialty.name);
        // update normalized name if empty
        if (specialty.normalizedName !== normSpecialty) {
            await this.prisma.vismedSpecialty.update({
                where: { id: specialty.id },
                data: { normalizedName: normSpecialty }
            });
        }

        // Check if already mapped actively
        const existing = await this.prisma.specialtyServiceMapping.findFirst({
            where: { vismedSpecialtyId, isActive: true }
        });
        if (existing) return true; // Already matched 

        // Fetch all doctoralia services
        const dServices = await this.prisma.doctoraliaService.findMany();
        if (dServices.length === 0) return false; // Nothing to match against

        // Layer 1: Exact Match
        const exactMatch = dServices.find(s => this.normalizeString(s.name) === normSpecialty);
        if (exactMatch) {
            await this.createMapping(specialty.id, exactMatch.id, 'EXACT', 1.0, false);
            return true;
        }

        // Layer 1.5: Contains Match
        // Ex: "cardiologia" is contained in "primeira consulta cardiologia" → score 0.90
        const containsMatch = dServices.find(s => {
            const normSvc = this.normalizeString(s.name);
            return normSvc.includes(normSpecialty) || normSpecialty.includes(normSvc);
        });
        if (containsMatch) {
            await this.createMapping(specialty.id, containsMatch.id, 'APPROXIMATE', 0.90, false);
            this.logger.log(`Contains-match: "${specialty.name}" → "${containsMatch.name}"`);
            return true;
        }

        // Layer 3: Synonym Match
        // We check this before Fuzzy because Synonym is a high confidence explicit match "Clínico Geral" -> "Consulta Clínica Geral"
        const synonyms = await this.prisma.mappingSynonym.findMany({
            where: {
                OR: [
                    { termA: specialty.name },
                    { termB: specialty.name },
                    // check lowercased terms as well just in case
                    { termA: { equals: specialty.name, mode: 'insensitive' } },
                    { termB: { equals: specialty.name, mode: 'insensitive' } }
                ]
            }
        });

        for (const syn of synonyms) {
            const targetTerm = syn.termA.toLowerCase() === specialty.name.toLowerCase() ? syn.termB : syn.termA;
            const targetNorm = this.normalizeString(targetTerm);
            const synMatch = dServices.find(s => this.normalizeString(s.name) === targetNorm);
            if (synMatch) {
                await this.createMapping(specialty.id, synMatch.id, 'SYNONYM', 0.95, false);
                return true;
            }
        }

        // Layer 2: Fuzzy Match (lowered threshold from 0.85 to 0.60 for broader coverage)
        let bestMatch = null;
        let bestScore = 0;

        for (const s of dServices) {
            const score = stringSimilarity.compareTwoStrings(normSpecialty, this.normalizeString(s.name));
            if (score > bestScore) {
                bestScore = score;
                bestMatch = s;
            }
        }

        if (bestMatch && bestScore >= 0.60) {
            // High confidence (>= 0.85) auto-approved, lower needs review
            const needsReview = bestScore < 0.85;
            await this.createMapping(specialty.id, bestMatch.id, 'APPROXIMATE', bestScore, needsReview);
            return true;
        }

        // Layer 4: Unmatched - No action needed, stays unmatched in VismedSpecialty (no mapping)
        this.logger.debug(`No match found for specialty: ${specialty.name}`);
        return false;
    }

    private async createMapping(vismedSpecialtyId: string, doctoraliaServiceId: string, matchType: MatchType, confidenceScore: number, requiresReview: boolean) {
        await this.prisma.specialtyServiceMapping.upsert({
            where: {
                vismedSpecialtyId_doctoraliaServiceId: {
                    vismedSpecialtyId,
                    doctoraliaServiceId
                }
            },
            update: {
                matchType,
                confidenceScore,
                requiresReview,
                isActive: true
            },
            create: {
                vismedSpecialtyId,
                doctoraliaServiceId,
                matchType,
                confidenceScore,
                requiresReview,
                isActive: true
            }
        });

        this.logger.log(`Mapped Vismed Specialty ${vismedSpecialtyId} to Doctoralia Service ${doctoraliaServiceId} (${matchType} - Score: ${confidenceScore})`);
    }

    async runMatchingForUnmatched(): Promise<number> {
        this.logger.log('Iniciando Rescan de Matching para Especialidades VisMed Órfãs...');

        // Find all specialties that don't have an active mapping
        const unmatchedSpecialties = await this.prisma.vismedSpecialty.findMany({
            where: {
                mappings: {
                    none: { isActive: true }
                }
            }
        });

        let newMatchesCount = 0;
        if (unmatchedSpecialties.length === 0) {
            this.logger.log('Nenhuma Especialidade VisMed Órfã encontrada.');
        } else {
            for (const spec of unmatchedSpecialties) {
                const matched = await this.runMatchingForSpecialty(spec.id);
                if (matched) newMatchesCount++;
            }
            this.logger.log(`Rescan Especialidades: ${newMatchesCount} novos matches encontrados dentre ${unmatchedSpecialties.length} órfãs.`);
        }

        // --- DOCTORS ---
        let newDocsCount = 0;
        const unmatchedDoctors = await this.prisma.vismedDoctor.findMany({
            where: {
                unifiedMappings: {
                    none: { isActive: true }
                }
            }
        });

        if (unmatchedDoctors.length === 0) {
            this.logger.log('Nenhum Médico VisMed Órfão encontrado.');
        } else {
            for (const doc of unmatchedDoctors) {
                const matched = await this.runMatchingForDoctor(doc.id);
                if (matched) newDocsCount++;
            }
            this.logger.log(`Rescan Profissionais: ${newDocsCount} novos matches encontrados dentre ${unmatchedDoctors.length} órfãos.`);
        }

        return newMatchesCount + newDocsCount;
    }

    async runMatchingForDoctor(vismedDoctorId: string): Promise<boolean> {
        const doc = await this.prisma.vismedDoctor.findUnique({
            where: { id: vismedDoctorId }
        });

        if (!doc || !doc.name) return false;

        const normDoc = this.normalizeString(doc.name);

        // Check if already mapped actively
        const existing = await this.prisma.professionalUnifiedMapping.findFirst({
            where: { vismedDoctorId, isActive: true }
        });
        if (existing) return true;

        // Fetch all doctoralia doctors
        const dDoctors = await this.prisma.doctoraliaDoctor.findMany();
        if (dDoctors.length === 0) return false;

        // Layer 1: Exact Match
        const exactMatch = dDoctors.find(d => this.normalizeString(d.name) === normDoc);
        if (exactMatch) {
            await this.createDoctorMapping(doc.id, exactMatch.id);
            return true;
        }

        // Layer 2: Fuzzy Match
        let bestMatch = null;
        let bestScore = 0;

        for (const d of dDoctors) {
            const score = stringSimilarity.compareTwoStrings(normDoc, this.normalizeString(d.name));
            if (score > bestScore) {
                bestScore = score;
                bestMatch = d;
            }
        }

        // Lower threshold for people names, 0.75 is reasonable if "Dr. Fulano" vs "Fulano"
        if (bestMatch && bestScore >= 0.75) {
            await this.createDoctorMapping(doc.id, bestMatch.id);
            return true;
        }

        this.logger.debug(`No match found for doctor: ${doc.name}`);
        return false;
    }

    private async createDoctorMapping(vismedDoctorId: string, doctoraliaDoctorId: string) {
        // Find existing to avoid unique constraint if we just want to reactivate
        const existingUnified = await this.prisma.professionalUnifiedMapping.findFirst({
            where: { vismedDoctorId, doctoraliaDoctorId }
        });

        if (existingUnified) {
            await this.prisma.professionalUnifiedMapping.update({
                where: { id: existingUnified.id },
                data: { isActive: true }
            });
        } else {
            await this.prisma.professionalUnifiedMapping.create({
                data: {
                    vismedDoctorId,
                    doctoraliaDoctorId,
                    isActive: true
                }
            });
        }

        // --- RECONCILE WITH GENERIC MAPPING TABLE ---
        // This ensures the Dashboard and legacy UIs show the doctor as LINKED
        try {
            const dDoc = await this.prisma.doctoraliaDoctor.findUnique({ where: { id: doctoraliaDoctorId } });
            if (dDoc && dDoc.doctoraliaDoctorId) {
                const extId = String(dDoc.doctoraliaDoctorId);

                // Find all mapping entries for this Doctoralia doctor across all clinics
                const mappings = await this.prisma.mapping.findMany({
                    where: {
                        entityType: 'DOCTOR',
                        externalId: extId
                    }
                });

                for (const map of mappings) {
                    // Check if there's a competing record for the same Vismed ID in this clinic
                    // to avoid unique constraint violation on [clinicId, entityType, vismedId]
                    const competing = await this.prisma.mapping.findFirst({
                        where: {
                            clinicId: map.clinicId,
                            entityType: 'DOCTOR',
                            vismedId: vismedDoctorId,
                            id: { not: map.id }
                        }
                    });

                    if (competing) {
                        // Merge and delete the competing one
                        await this.prisma.mapping.delete({ where: { id: competing.id } });
                    }

                    await this.prisma.mapping.update({
                        where: { id: map.id },
                        data: {
                            vismedId: vismedDoctorId,
                            status: 'LINKED'
                        }
                    });
                }
            }
        } catch (e: any) {
            this.logger.error(`Error reconciling doctor mapping: ${e.message}`);
        }

        this.logger.log(`Mapped Vismed Doctor ${vismedDoctorId} to Doctoralia Doctor ${doctoraliaDoctorId}`);
    }
}
