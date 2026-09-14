import { userWriteInput } from './user-write-input';

describe('User write input', () => {
    it('accepts explicit user fields and trims name/email', () => {
        expect(userWriteInput({ name: ' Test ', email: ' test@example.invalid ', password: 'test-password', clinicId: 'clinic', role: 'READONLY', active: false }, true))
            .toEqual({ name: 'Test', email: 'test@example.invalid', password: 'test-password', clinicId: 'clinic', role: 'READONLY', active: false });
    });
    it.each([null, [], {}, { name: {} }, { email: 'invalid' }, { active: 'false' }, { password: 'short' }, { roles: { create: {} } }, { id: 'replace-id' }])('rejects invalid update %j', body => {
        expect(() => userWriteInput(body)).toThrow();
    });
    it.each([
        { name: 'Test', email: 'test@example.invalid' },
        { name: 'Test', email: 'test@example.invalid', password: 'test-password', role: 'SUPER_ADMIN' },
        { name: 'Test', email: 'test@example.invalid', password: 'test-password', clinicId: 'clinic', role: 'UNKNOWN' },
        { name: 'Test', email: 'test@example.invalid', password: 'test-password', roles: { create: {} } },
    ])('rejects invalid creation %j', body => expect(() => userWriteInput(body, true)).toThrow());
});
