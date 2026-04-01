const { DocplannerClient } = require('./src/integrations/docplanner.service.js'); // Cannot require TS directly in this env without ts-node
// Alternatively, I will use fetch
require('dotenv').config();

async function testApi() {
    const domain = 'br';
    const clientId = process.env.DOCPLANNER_API_KEY; // Actually we don't have this, we have credentials in DB
    console.log('Use NestJS runtime to test this.');
}
testApi();
