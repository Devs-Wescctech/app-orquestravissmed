const { PrismaClient } = require('@prisma/client');
const { DocplannerService } = require('./dist/src/integrations/docplanner.service');
const { ConfigService } = require('@nestjs/config');
const prisma = new PrismaClient();
const config = new ConfigService();

async function check() {
    const docplanner = new DocplannerService();
    const conns = await prisma.integrationConnection.findMany({ where: { provider: 'doctoralia' } });
    if (conns.length === 0) return console.log("No doctoralia connections");

    for (const c of conns) {
        console.log(`- Clinic: ${c.clinicId}`);
        const client = docplanner.createClient(c.domain, c.clientId, c.clientSecret);
        await client.authenticate();

        const facilities = await client.getFacilities();
        const facilityId = facilities._items[0].id;
        const docs = await client.getDoctors(facilityId);
        console.log("Full JSON for the first doctor:");
        console.log(JSON.stringify(docs._items[0], null, 2));
    }
}
check().catch(console.error).finally(() => prisma.$disconnect());
