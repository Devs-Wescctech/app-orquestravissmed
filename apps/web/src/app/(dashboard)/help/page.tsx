import manualContent from '../../../../../../docs/manual-utilizacao.md';
import { HelpContent } from './HelpContent';

export default function HelpPage() {
    const content =
        typeof manualContent === 'string' && manualContent.trim().length > 0
            ? manualContent
            : '# Manual indisponível\n\nO conteúdo do manual não foi incluído neste build. Entre em contato com o suporte.';
    return <HelpContent content={content} />;
}
