import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';

@Injectable()
export class DoctorsService {
    private readonly logger = new Logger(DoctorsService.name);

    constructor(
        private prisma: PrismaService,
        private docplanner: DocplannerService,
    ) { }

    /**
     * Returns doctors synced from Doctoralia AND VisMed (from the Mapping table)
     */
    async findAllFromDoctoralia(clinicId: string) {
        const mappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
            orderBy: { createdAt: 'desc' },
            // Important: Load Vismed info to fallback if Docplanner data is absent
        });

        const enhancedMappings = await Promise.all(mappings.map(async (m) => {
            let vismedDoc = null;
            if (m.vismedId) {
                vismedDoc = await this.prisma.vismedDoctor.findUnique({ where: { id: m.vismedId } });
            }
            return { ...m, vismedDoc };
        }));

        return enhancedMappings.map(m => {
            const cd = m.conflictData as any || {};

            // If we have vismedDoc but no Docplanner name, use Vismed Name
            const fallbackName = m.vismedDoc?.name || 'Desconhecido';
            const name = cd.name || fallbackName;
            const surname = cd.surname || '';
            const fullName = surname ? `${name} ${surname}`.trim() : name;

            return {
                id: m.id,
                externalId: m.externalId,
                name,
                surname,
                fullName,
                address: cd.address || null,
                services: cd.services || [],
                calendarStatus: cd.calendarStatus || 'unknown',
                status: m.status,
                vismedId: m.vismedId,
                syncedAt: m.updatedAt,
                source: m.externalId && m.vismedId ? 'BOTH' : (m.vismedId ? 'VISMED' : 'DOCTORALIA')
            };
        });
    }

    /**
     * Fetches all doctors live from Doctoralia API with enriched data (addresses, services, calendar status)
     */
    async fetchLive(clinicId: string) {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            throw new Error('Integração Doctoralia não configurada');
        }

        const client = this.docplanner.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret || '',
        );

        const facilitiesRes = await client.getFacilities();
        const facilities = facilitiesRes._items || [];
        if (facilities.length === 0) return [];

        const facilityId = String(facilities[0].id);
        const facilityName = facilities[0].name;
        const doctorsRes = await client.getDoctors(facilityId);
        const doctorsList = doctorsRes._items || [];

        const enrichedDoctors = [];
        for (const doc of doctorsList) {
            const doctorId = String(doc.id);
            let address = null;
            let services: any[] = [];
            let calendarStatus = 'unknown';

            try {
                const addrRes = await client.getAddresses(facilityId, doctorId);
                const addresses = addrRes._items || [];
                if (addresses.length > 0) {
                    address = addresses[0];
                    const addressId = String(address.id);

                    // Fetch services
                    try {
                        const svcRes = await client.getServices(facilityId, doctorId, addressId);
                        services = svcRes._items || [];
                    } catch (e: any) {
                        this.logger.warn(`Services fetch failed for doctor ${doctorId}: ${e.message}`);
                    }

                    // Fetch calendar status
                    try {
                        const calRes = await client.getCalendarStatus(facilityId, doctorId, addressId);
                        calendarStatus = calRes.status || 'unknown';
                    } catch (e: any) {
                        this.logger.warn(`Calendar status fetch failed for doctor ${doctorId}: ${e.message}`);
                    }
                }
            } catch (e: any) {
                this.logger.warn(`Address fetch failed for doctor ${doctorId}: ${e.message}`);
            }

            // Update Mapping conflictData with enriched info
            const existingMapping = await this.prisma.mapping.findUnique({
                where: {
                    clinicId_entityType_externalId: {
                        clinicId,
                        entityType: 'DOCTOR',
                        externalId: doctorId,
                    },
                },
            });

            const conflictData = {
                name: doc.name,
                surname: doc.surname || '',
                externalId: doc.id,
                facilityId,
                facilityName,
                address: address ? {
                    id: address.id,
                    name: address.name,
                    city: address.city_name,
                    street: address.street,
                    postCode: address.post_code,
                } : null,
                services: services.map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    serviceId: s.service_id,
                })),
                calendarStatus,
            };

            if (existingMapping) {
                await this.prisma.mapping.update({
                    where: { id: existingMapping.id },
                    data: { conflictData },
                });
            } else {
                await this.prisma.mapping.create({
                    data: {
                        clinicId,
                        entityType: 'DOCTOR',
                        externalId: doctorId,
                        status: 'UNLINKED',
                        conflictData,
                    },
                });
            }

            enrichedDoctors.push({
                externalId: doctorId,
                name: doc.name,
                surname: doc.surname || '',
                fullName: `${doc.name} ${doc.surname || ''}`.trim(),
                address: conflictData.address,
                services: conflictData.services,
                calendarStatus,
                status: existingMapping?.status || 'UNLINKED',
            });
        }

        return enrichedDoctors;
    }

    /**
     * Count synced doctors
     */
    async count(clinicId: string) {
        const total = await this.prisma.mapping.count({
            where: { clinicId, entityType: 'DOCTOR' },
        });
        const linked = await this.prisma.mapping.count({
            where: { clinicId, entityType: 'DOCTOR', status: 'LINKED' },
        });
        const unlinked = await this.prisma.mapping.count({
            where: { clinicId, entityType: 'DOCTOR', status: 'UNLINKED' },
        });
        return { total, linked, unlinked };
    }
}
