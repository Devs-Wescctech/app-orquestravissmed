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
            const needsReview = bestScore < 0.70;
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

    private static readonly INSURANCE_NOISE_WORDS = new Set([
        'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'a', 'o', 'para', 'com',
        'r$', 'na', 'no', 'ao', 'por', 'que', 'uma', 'um',
    ]);

    private static readonly NON_INSURANCE_PATTERNS = [
        /orcamento/i,
        /r\$\s*\d/i,
        /a\s+vista/i,
        /parcelad/i,
        /faturar/i,
        /particular/i,
    ];

    private extractInsuranceCoreTokens(name: string): string[] {
        const norm = this.normalizeString(name);
        const cleaned = norm
            .replace(/[-–—]/g, ' ')
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned.split(' ')
            .filter(w => w.length >= 3 && !MatchingEngineService.INSURANCE_NOISE_WORDS.has(w));
    }

    private isLikelyNonInsurance(name: string): boolean {
        const norm = this.normalizeString(name);
        return MatchingEngineService.NON_INSURANCE_PATTERNS.some(p => p.test(norm));
    }

    async runMatchingForInsurance(vismedInsuranceId: string): Promise<boolean> {
        const insurance = await this.prisma.vismedInsurance.findUnique({
            where: { id: vismedInsuranceId }
        });
        if (!insurance) return false;

        const normInsurance = this.normalizeString(insurance.name);

        const existingMapping = await this.prisma.mapping.findFirst({
            where: {
                entityType: 'INSURANCE',
                vismedId: vismedInsuranceId,
                status: 'LINKED'
            }
        });
        if (existingMapping) return true;

        if (this.isLikelyNonInsurance(insurance.name)) {
            this.logger.log(`Insurance "${insurance.name}" classified as non-insurance (payment/internal), skipping match`);
            return false;
        }

        const dProviders = await this.prisma.doctoraliaInsuranceProvider.findMany();
        if (dProviders.length === 0) return false;

        const exactMatch = dProviders.find(p => this.normalizeString(p.name) === normInsurance);
        if (exactMatch) {
            await this.linkInsuranceMapping(vismedInsuranceId, exactMatch);
            this.logger.log(`Insurance exact match (100%): "${insurance.name}" → "${exactMatch.name}" (doctoraliaId: ${exactMatch.doctoraliaId}) — AUTO-LINKED`);
            return true;
        }

        const containsMatch = dProviders.find(p => {
            const normP = this.normalizeString(p.name);
            if (normP.length < 4 || normInsurance.length < 4) return false;
            return normP.includes(normInsurance) || normInsurance.includes(normP);
        });
        if (containsMatch) {
            await this.pendingReviewInsuranceMapping(vismedInsuranceId, containsMatch, 0.90);
            this.logger.log(`Insurance contains match (~90%): "${insurance.name}" → "${containsMatch.name}" — PENDING MANUAL REVIEW`);
            return true;
        }

        const coreTokens = this.extractInsuranceCoreTokens(insurance.name);
        if (coreTokens.length > 0) {
            let bestTokenMatch: any = null;
            let bestTokenScore = 0;

            for (const p of dProviders) {
                const providerTokens = this.extractInsuranceCoreTokens(p.name);
                if (providerTokens.length === 0) continue;

                const MIN_SUBSTRING_LEN = 4;
                const matchingTokens = coreTokens.filter(t =>
                    providerTokens.some(pt =>
                        pt === t ||
                        (t.length >= MIN_SUBSTRING_LEN && pt.includes(t)) ||
                        (pt.length >= MIN_SUBSTRING_LEN && t.includes(pt))
                    )
                );
                const tokenScore = matchingTokens.length / Math.max(coreTokens.length, 1);

                const diceScore = stringSimilarity.compareTwoStrings(
                    coreTokens.join(' '),
                    providerTokens.join(' ')
                );

                const combinedScore = (tokenScore * 0.6) + (diceScore * 0.4);

                if (combinedScore > bestTokenScore) {
                    bestTokenScore = combinedScore;
                    bestTokenMatch = p;
                }
            }

            if (bestTokenMatch && bestTokenScore >= 0.55) {
                await this.pendingReviewInsuranceMapping(vismedInsuranceId, bestTokenMatch, bestTokenScore);
                this.logger.log(`Insurance token match (${(bestTokenScore * 100).toFixed(0)}%): "${insurance.name}" → "${bestTokenMatch.name}" — PENDING MANUAL REVIEW`);
                return true;
            }
        }

        let bestMatch = null;
        let bestScore = 0;
        for (const p of dProviders) {
            const score = stringSimilarity.compareTwoStrings(normInsurance, this.normalizeString(p.name));
            if (score > bestScore) {
                bestScore = score;
                bestMatch = p;
            }
        }

        if (bestMatch && bestScore >= 0.65) {
            const insTokens = this.extractInsuranceCoreTokens(insurance.name);
            const provTokens = this.extractInsuranceCoreTokens(bestMatch.name);
            const hasSharedToken = insTokens.some(t => provTokens.some(pt => pt === t));
            if (hasSharedToken) {
                await this.pendingReviewInsuranceMapping(vismedInsuranceId, bestMatch, bestScore);
                this.logger.log(`Insurance fuzzy match (${(bestScore * 100).toFixed(0)}%): "${insurance.name}" → "${bestMatch.name}" — PENDING MANUAL REVIEW`);
                return true;
            }
            this.logger.debug(`Insurance fuzzy match ${(bestScore * 100).toFixed(0)}% rejected (no shared tokens): "${insurance.name}" vs "${bestMatch.name}"`);
        }

        this.logger.debug(`No insurance match found for: ${insurance.name}`);
        return false;
    }

    private async linkInsuranceMapping(vismedInsuranceId: string, doctoraliaProvider: any) {
        const mappings = await this.prisma.mapping.findMany({
            where: {
                entityType: 'INSURANCE',
                vismedId: vismedInsuranceId,
            }
        });
        for (const m of mappings) {
            try {
                await this.prisma.mapping.update({
                    where: { id: m.id },
                    data: {
                        externalId: String(doctoraliaProvider.doctoraliaId),
                        status: 'LINKED',
                        conflictData: { doctoraliaProviderId: doctoraliaProvider.doctoraliaId, doctoraliaProviderName: doctoraliaProvider.name }
                    }
                });
            } catch (e: any) {
                if (e.code === 'P2002') {
                    this.logger.debug(`Insurance mapping already exists for externalId ${doctoraliaProvider.doctoraliaId}, skipping duplicate.`);
                } else {
                    throw e;
                }
            }
        }
    }

    private async pendingReviewInsuranceMapping(vismedInsuranceId: string, doctoraliaProvider: any, score: number) {
        const mappings = await this.prisma.mapping.findMany({
            where: {
                entityType: 'INSURANCE',
                vismedId: vismedInsuranceId,
            }
        });
        for (const m of mappings) {
            if (m.status === 'LINKED') continue;
            try {
                await this.prisma.mapping.update({
                    where: { id: m.id },
                    data: {
                        externalId: String(doctoraliaProvider.doctoraliaId),
                        status: 'PENDING_REVIEW',
                        conflictData: {
                            doctoraliaProviderId: doctoraliaProvider.doctoraliaId,
                            doctoraliaProviderName: doctoraliaProvider.name,
                            matchScore: score,
                            requiresManualApproval: true
                        }
                    }
                });
            } catch (e: any) {
                if (e.code === 'P2002') {
                    this.logger.debug(`Insurance mapping already exists for externalId ${doctoraliaProvider.doctoraliaId}, skipping duplicate.`);
                } else {
                    throw e;
                }
            }
        }
    }

    async runMatchingForUnmatched(): Promise<number> {
        this.logger.log('Iniciando Rescan de Matching para Especialidades VisMed Órfãs...');

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

        // --- INSURANCE / CONVÊNIOS ---
        let newInsCount = 0;
        const allInsurances = await this.prisma.vismedInsurance.findMany();

        let cleanedCount = 0;
        for (const ins of allInsurances) {
            if (this.isLikelyNonInsurance(ins.name)) {
                const badMappings = await this.prisma.mapping.findMany({
                    where: { entityType: 'INSURANCE', vismedId: ins.id, status: { in: ['LINKED', 'PENDING_REVIEW'] } }
                });
                for (const bm of badMappings) {
                    await this.prisma.mapping.update({ where: { id: bm.id }, data: { status: 'UNLINKED', externalId: null, conflictData: {} } });
                    cleanedCount++;
                    this.logger.warn(`Cleaned false-positive insurance match: "${ins.name}" (was ${bm.status})`);
                }
            }
        }
        if (cleanedCount > 0) {
            this.logger.log(`Cleaned ${cleanedCount} false-positive insurance match(es) via NON_INSURANCE_PATTERNS.`);
        }

        const alreadyProcessedInsIds = (await this.prisma.mapping.findMany({
            where: { entityType: 'INSURANCE', status: { in: ['LINKED', 'PENDING_REVIEW'] } },
            select: { vismedId: true }
        })).map(m => m.vismedId).filter(Boolean);

        const insurancesToMatch = allInsurances.filter(i => !alreadyProcessedInsIds.includes(i.id));

        if (insurancesToMatch.length === 0) {
            this.logger.log('Nenhum Convênio VisMed Órfão encontrado.');
        } else {
            for (const ins of insurancesToMatch) {
                const matched = await this.runMatchingForInsurance(ins.id);
                if (matched) newInsCount++;
            }
            this.logger.log(`Rescan Convênios: ${newInsCount} novos matches encontrados dentre ${insurancesToMatch.length} órfãos.`);
        }

        return newMatchesCount + newDocsCount + newInsCount;
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
