const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../src/app/(dashboard)/appointments/page.tsx'), 'utf8').replace(/\r\n/g, '\n');

test('both calendar data sources are filtered before merging and counting', () => {
    for (const [item, collection] of [['rec', 'syncRecords'], ['b', 'doctoraliaBookings']]) {
        assert.ok(source.includes(`for (const ${item} of ${collection}) {\n            if (${item}.appointmentType !== 'Consulta') continue;`));
    }
});
test('confirmed type survives the direct Doctoralia calendar projection', () => {
    const projection = source.slice(source.indexOf('const newRec: BookingRecord ='), source.indexOf('// Anti-duplicata visual'));
    assert.ok(projection.includes("appointmentType: 'Consulta'"));
    assert.ok(source.includes('for (const b of allBookings)'));
});
