import { PrismaClient } from '@prisma/client';
import { DocplannerClient } from './src/integrations/docplanner.service';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function run() {
    console.log('Fetching integrations...');
    const clinic = await prisma.clinic.findFirst({
        where: { integrations: { some: { provider: 'doctoralia' } } },
        include: { integrations: true }
    });

    if (!clinic) {
        console.log('No clinic with Doctoralia integration found.');
        return;
    }

    const integration = clinic.integrations.find(i => i.provider === 'doctoralia');
    if (!integration) {
        console.log('Integration not found.');
        return;
    }
    const client = new DocplannerClient(null as any);
    client.setBaseUrl(integration.domain || 'doctoralia.com.br');
    await client.authenticate(integration.clientId!, integration.clientSecret!);

    console.log('Fetching mapped doctors...');
    // We need a doctor who is mapped
    const mapping = await prisma.professionalUnifiedMapping.findFirst({
        where: { isActive: true },
        include: {
            doctoraliaDoctor: true
        }
    });

    if (!mapping) {
         console.log('No mapped doctor found.');
         return;
    }

    const dDoc = mapping.doctoraliaDoctor;
    
    console.log(`Getting addresses for facility ${dDoc.doctoraliaFacilityId}, doctor ${dDoc.doctoraliaDoctorId}`);
    const addrsRes = await client.getAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId);
    if (!addrsRes || !addrsRes._items || addrsRes._items.length === 0) {
        console.log('No addresses found for doctor.');
        return;
    }

    const addr = addrsRes._items[0];
    const addrId = String(addr.id);

    let street = '';
    if (clinic.addressStreet) {
        street = clinic.addressStreet;
        if (clinic.addressNumber) street += `, ${clinic.addressNumber}`;
        if (clinic.addressComplement) street += ` - ${clinic.addressComplement}`;
        if (clinic.addressNeighborhood) street += ` (${clinic.addressNeighborhood})`;
    }

    const addressPayload: any = {
        insurance_support: addr.insurance_support || 'private',
    };

    if (street) addressPayload.street = street;
    if (clinic.addressCity) addressPayload.city_name = clinic.addressCity;
    if (clinic.addressZipCode) addressPayload.post_code = clinic.addressZipCode;

    console.log('Payload to send:', JSON.stringify(addressPayload, null, 2));

    const artifactPath = 'C:/Users/cristian.lima/.gemini/antigravity/brain/32cc4622-ae56-4afa-b790-b676d7f4bacc/diagnostics_address_payload.json';

    const report = {
        investigation: "Doctoralia returns 200 OK but ignores address metadata.",
        endpointCalled: `PATCH /api/v3/integration/facilities/${dDoc.doctoraliaFacilityId}/doctors/${dDoc.doctoraliaDoctorId}/addresses/${addrId}`,
        vismedPayloadSent: addressPayload,
        responseStatus: null as any,
        doctoraliaResponseReceived: null as any,
        beforeUpdateAddressState: addr
    };

    try {
        const response = await client.updateAddress(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, addressPayload);
        report.responseStatus = "200 OK"; 
        report.doctoraliaResponseReceived = response;
    } catch (e: any) {
        report.responseStatus = e.message;
        report.doctoraliaResponseReceived = e;
    }

    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2));
    console.log(`Report successfully written to ${artifactPath}`);
}

run()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
