const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();


const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function test() {
    console.log('Fetching Docplanner token...');
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    console.log('Fetching active mappings...');
    const mappings = await prisma.professionalUnifiedMapping.findMany({
        where: { isActive: true },
        include: {
            vismedDoctor: {
                include: {
                    specialties: {
                        include: {
                            specialty: {
                                include: {
                                    mappings: {
                                        where: { isActive: true },
                                        include: { doctoraliaService: true }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            doctoraliaDoctor: true
        }
    });

    for (const mapping of mappings) {
        const vDoc = mapping.vismedDoctor;
        const dDoc = mapping.doctoraliaDoctor;
        console.log(`\n======================================================`);
        console.log(`Doctor: ${vDoc.name} (VM) <-> ${dDoc.name} (DC)`);

        // 1. VisMed Expected Services
        console.log(`\n--- VisMed Specialties (Expected Services) ---`);
        const expectedDictIds = new Map();
        for (const vs of vDoc.specialties) {
            const spec = vs.specialty;
            let mappedTo = 'NOT MAPPED';
            if (spec && spec.mappings && spec.mappings.length > 0) {
                const map = spec.mappings[0];
                const dictId = map.doctoraliaService.doctoraliaServiceId;
                mappedTo = `Doctoralia Dict ID: ${dictId}`;
                expectedDictIds.set(String(dictId), spec.name);
            }
            console.log(`- ${spec.name} => ${mappedTo}`);
        }

        // 2. Doctoralia Current Services
        console.log(`\n--- Doctoralia Current Services ---`);
        const addrsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${dDoc.doctoraliaFacilityId}/doctors/${dDoc.doctoraliaDoctorId}/addresses`, { headers });
        const addrs = await addrsRes.json();

        for (const addr of (addrs._items || [])) {
            console.log(`\nAddress: ${addr.id} (${addr.name})`);
            const svcsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${dDoc.doctoraliaFacilityId}/doctors/${dDoc.doctoraliaDoctorId}/addresses/${addr.id}/services`, { headers });
            const currentServices = (await svcsRes.json())._items || [];

            const currentByDictId = new Map();
            for (const svc of currentServices) {
                const dictId = String(svc.service_id || svc.id);
                currentByDictId.set(dictId, svc);
                console.log(`- Service ID: ${svc.id} | Dict ID: ${dictId} | Name: ${svc.name}`);
            }

            // 3. Delta 
            console.log(`\n--- DELTA FOR PUSH ---`);
            let adds = 0, dels = 0;
            for (const [dictId, specName] of expectedDictIds.entries()) {
                if (!currentByDictId.has(dictId)) {
                    console.log(`[ADD] Will add service dict:${dictId} (${specName})`);
                    adds++;
                }
            }
            for (const [dictId, svc] of currentByDictId.entries()) {
                if (!expectedDictIds.has(dictId)) {
                    console.log(`[DELETE] Will delete service addr_svc:${svc.id} (dict:${dictId} - ${svc.name})`);
                    dels++;
                }
            }
            if (adds === 0 && dels === 0) console.log(`[OK] Services perfectly synced!`);
        }
    }

    await prisma.$disconnect();
}

test().catch(console.error);
