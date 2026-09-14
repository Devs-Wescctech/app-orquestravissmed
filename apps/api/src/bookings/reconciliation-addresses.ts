/** Only appointments being reconciled can contribute a remote route. */
export function reconciliationAddresses(records: Array<{ doctoraliaBookingId?: string | null; doctoraliaAddressId?: string | null; doctoraliaFacilityId?: string | null }>) {
    const pairs = new Map<string, { doctoraliaAddressId: string; doctoraliaFacilityId: string }>();
    for (const record of records) {
        if (!record.doctoraliaBookingId || !record.doctoraliaAddressId || !record.doctoraliaFacilityId) continue;
        const pair = { doctoraliaAddressId: record.doctoraliaAddressId, doctoraliaFacilityId: record.doctoraliaFacilityId };
        pairs.set(JSON.stringify([pair.doctoraliaFacilityId, pair.doctoraliaAddressId]), pair);
    }
    return [...pairs.values()];
}
