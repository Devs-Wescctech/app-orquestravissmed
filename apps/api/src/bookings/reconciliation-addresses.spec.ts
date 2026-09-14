import { reconciliationAddresses } from './reconciliation-addresses';
describe('reconciliation address scope', () => {
    it('excludes break-only records and incomplete routes', () => {
        expect(reconciliationAddresses([
            { doctoraliaBookingId: 'booking', doctoraliaAddressId: 'correct', doctoraliaFacilityId: 'facility' },
            { doctoraliaBookingId: null, doctoraliaAddressId: 'historical', doctoraliaFacilityId: 'facility' },
            { doctoraliaBookingId: 'incomplete', doctoraliaAddressId: null, doctoraliaFacilityId: 'facility' },
        ])).toEqual([{ doctoraliaAddressId: 'correct', doctoraliaFacilityId: 'facility' }]);
    });
    it('deduplicates exact pairs without conflating facilities', () => {
        const rows = ['one', 'one', 'two'].map(doctoraliaFacilityId => ({ doctoraliaBookingId: 'booking', doctoraliaAddressId: 'address', doctoraliaFacilityId }));
        expect(reconciliationAddresses(rows)).toHaveLength(2);
    });
});
