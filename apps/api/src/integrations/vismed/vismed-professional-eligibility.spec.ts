import { VismedService } from './vismed.service';

describe('eligibility HTTP contract', () => {
    it('requires HTTP 200 and preserves the raw response instead of coercing errors to an empty list', async () => {
        const service = new VismedService();
        const request = jest.spyOn(service as any, 'requestJson').mockResolvedValue(null);
        await expect(service.getProfissionaisForEligibility(52, 'https://app.vissmed.com.br/api-docctor-3')).resolves.toBeNull();
        expect(request).toHaveBeenCalledWith('profissionais-by-idempresagestora?idempresagestora=52', 'https://app.vissmed.com.br/api-docctor-3', undefined, true, true);
    });
});
