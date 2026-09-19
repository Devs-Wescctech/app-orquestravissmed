import { DisabledProfessionalSlots } from './disabled-professional-slots';
import { cleanupReasons, describeCleanupIssues } from './cleanup-diagnostics';
import { managedSlotState } from './managed-slot-ranges';
import { periodsHash } from './managed-period-replacement';

const scope = { clinicId: 'c', facilityId: 'f', doctorId: 'd', addressId: 'a' };
const now = new Date('2029-01-01');
const period = {
  start: '2030-01-02T08:00:00-03:00',
  end: '2030-01-02T08:30:00-03:00',
  address_services: [{ address_service_id: '5', duration: 30 }],
};
function fixture() {
  const hash = periodsHash([period]);
  const state: any = {
    id: 's',
    addressId: 'a',
    availabilityHash: hash,
    managedState: managedSlotState(scope, hash, [period]),
  };
  const prisma: any = {
    slotPushState: {
      findMany: async () => [state],
      findUnique: jest.fn(async () => state),
      updateMany: jest.fn(),
    },
    mapping: {
      findFirst: jest.fn(async () => ({ id: 'm' })),
      findMany: jest.fn(async () => []),
    },
  };
  const client: any = {
    replaceSlots: jest.fn(),
    getBookings: jest.fn(async () => ({ _items: [] })),
    getCalendarBreaks: jest.fn(async () => ({ _items: [] })),
    getSlotsForReconciliation: jest.fn(async () => ({ _items: [] })),
  };
  const eligible = jest.fn(async () => true);
  const run = (clock = now) =>
    new DisabledProfessionalSlots(prisma).reconcile(
      'c',
      'local',
      'f',
      'd',
      client,
      eligible,
      undefined,
      clock,
    );
  return { state, prisma, client, eligible, run };
}
describe('cleanup diagnostics contract', () => {
  it.each([
    'journal_missing_periods',
    'journal_scope_mismatch',
    'journal_hash_mismatch',
    'journal_invalid',
    'invalid_clock',
    'mapping_missing',
    'mapping_shared',
    'journal_changed',
    'eligibility_changed',
    'remote_mismatch',
    'period_in_progress',
  ] as const)('retains state and describes %s', async (code) => {
    const f = fixture();
    if (code === 'journal_missing_periods') f.state.managedState = null;
    if (code === 'journal_scope_mismatch')
      f.state.managedState.clinicId = 'other';
    if (code === 'journal_hash_mismatch')
      f.state.managedState.periodsHash = 'wrong';
    if (code === 'journal_invalid') f.state.managedState.periods = {};
    if (code === 'mapping_missing')
      f.prisma.mapping.findFirst.mockResolvedValue(null);
    if (code === 'mapping_shared')
      f.prisma.mapping.findMany.mockResolvedValue([{ id: 'other' }]);
    if (code === 'journal_changed')
      f.prisma.slotPushState.findUnique.mockResolvedValue({
        availabilityHash: 'changed',
      });
    if (code === 'eligibility_changed') f.eligible.mockResolvedValue(false);
    const before = structuredClone(f.state);
    const result = await f.run(
      code === 'invalid_clock'
        ? new Date('invalid')
        : code === 'period_in_progress'
          ? new Date('2030-01-02T11:15:00Z')
          : now,
    );
    expect(result.pending).toBe(1);
    expect(result.issues[0]).toMatchObject({
      addressId: 'a',
      code,
      writeState: 'not_sent',
    });
    expect(f.client.replaceSlots).not.toHaveBeenCalled();
    expect(f.prisma.slotPushState.updateMany).not.toHaveBeenCalled();
    expect(f.state).toEqual(before);
  });
  it.each([
    null,
    {},
    [{ start: 'invalid', end: 'invalid' }],
    [{ start: period.end, end: period.start }],
  ])('does not suppress malformed legacy ranges %j', async (ranges) => {
    const f = fixture();
    delete f.state.managedState.periods;
    delete f.state.managedState.periodsHash;
    f.state.managedState.ranges = ranges;
    expect((await f.run()).pending).toBe(1);
  });
  it('does not consult a date outside the explicitly allowed window', async () => {
    const f = fixture();
    const result = await new DisabledProfessionalSlots(f.prisma).reconcile(
      'c',
      'local',
      'f',
      'd',
      f.client,
      f.eligible,
      ['2030-01-03'],
      now,
    );
    expect(result).toEqual({ cleared: 0, pending: 0, issues: [] });
    expect(f.client.getBookings).not.toHaveBeenCalled();
  });
  it('provides distinct language for no write, uncertain write and confirmed remote write', () => {
    for (const [code, message] of Object.entries(cleanupReasons))
      expect(message.length).toBeGreaterThan(10);
    const result = describeCleanupIssues([
      {
        addressId: 'a',
        date: '2030-01-02',
        code: 'bookings_present',
        writeState: 'not_sent',
      },
      { addressId: 'b', code: 'write_unconfirmed', writeState: 'unknown' },
      {
        addressId: 'c',
        code: 'journal_update_failed',
        writeState: 'confirmed',
      },
    ]);
    expect(result).toContain('Endereço a, data 2030-01-02');
    expect(result).toContain('Nenhuma remoção enviada');
    expect(result).toContain('Resultado remoto ainda não confirmado');
    expect(result).toContain(
      'Resultado remoto confirmado; registro local pendente',
    );
  });
});
