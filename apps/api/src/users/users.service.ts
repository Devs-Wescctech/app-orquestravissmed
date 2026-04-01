import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
    constructor(private prisma: PrismaService) { }

    async findByEmail(email: string) {
        return this.prisma.user.findUnique({
            where: { email },
            include: {
                roles: {
                    include: {
                        clinic: true,
                    }
                }
            }
        });
    }

    async findById(id: string) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            include: {
                roles: {
                    include: {
                        clinic: true,
                    }
                }
            }
        });
        if (!user) return null;
        const { password, ...result } = user;
        return result;
    }

    async findAll() {
        const users = await this.prisma.user.findMany({
            include: {
                roles: {
                    include: {
                        clinic: true
                    }
                }
            }
        });
        return users.map(u => {
            const { password, ...result } = u;
            return result;
        });
    }
}
