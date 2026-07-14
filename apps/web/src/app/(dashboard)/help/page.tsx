import fs from 'fs';
import path from 'path';
import { HelpContent } from './HelpContent';

export const dynamic = 'force-dynamic';

function loadManual(): string {
    const candidates = [
        path.join(process.cwd(), '..', '..', 'docs', 'manual-utilizacao.md'),
        path.join(process.cwd(), 'docs', 'manual-utilizacao.md'),
    ];
    for (const p of candidates) {
        try {
            return fs.readFileSync(p, 'utf-8');
        } catch { }
    }
    return '# Manual indisponível\n\nO arquivo do manual não foi encontrado.';
}

export default function HelpPage() {
    const content = loadManual();
    return <HelpContent content={content} />;
}
