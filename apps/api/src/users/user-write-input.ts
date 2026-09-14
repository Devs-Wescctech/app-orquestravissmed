import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';

/** API input only; never forward arbitrary Prisma relation operations. */
export function userWriteInput(body: unknown, creating = false): Record<string, any> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Dados do usuário inválidos');
    const fields = creating ? ['name', 'email', 'password', 'active', 'clinicId', 'role'] : ['name', 'email', 'password', 'active'];
    const data = body as Record<string, any>;
    if (Object.keys(data).some(key => !fields.includes(key))) throw new BadRequestException('Campo não permitido. Altere vínculos e perfis pela gestão de clínicas.');
    const result: Record<string, any> = {};
    for (const key of ['name', 'email', 'clinicId']) {
        if (data[key] !== undefined) {
            if (typeof data[key] !== 'string' || !data[key].trim()) throw new BadRequestException(`Campo ${key} inválido`);
            result[key] = data[key].trim();
        }
    }
    if (creating && (!result.name || !result.email || data.password === undefined)) throw new BadRequestException('Nome, e-mail e senha são obrigatórios');
    if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new BadRequestException('E-mail inválido');
    if (data.password !== undefined) {
        if (typeof data.password !== 'string' || data.password.length < 6) throw new BadRequestException('A senha deve ter pelo menos 6 caracteres');
        result.password = data.password;
    }
    if (data.active !== undefined) {
        if (typeof data.active !== 'boolean') throw new BadRequestException('Status do usuário inválido');
        result.active = data.active;
    }
    if (data.role !== undefined) {
        if (!Object.values(Role).includes(data.role) || !result.clinicId) throw new BadRequestException('Perfil e clínica inválidos');
        result.role = data.role;
    }
    if (!Object.keys(result).length) throw new BadRequestException('Informe os dados para alteração');
    return result;
}
