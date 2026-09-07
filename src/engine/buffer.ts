import { BLANK_CHAR } from '../config';

/**
 * Grade de caracteres com a classe CSS de cada célula.
 *
 * O buffer é alocado uma vez por layout e reaproveitado a cada quadro: o laço
 * de animação limpa e repinta em vez de criar arrays novos 60 vezes por segundo.
 */
export class CharBuffer {
    private readonly chars: string[][];
    private readonly classes: string[][];

    constructor(
        readonly rowCount: number,
        readonly colCount: number,
    ) {
        this.chars = Array.from({ length: rowCount }, () => new Array<string>(colCount).fill(BLANK_CHAR));
        this.classes = Array.from({ length: rowCount }, () => new Array<string>(colCount).fill(''));
    }

    /** Escreve uma célula, ignorando em silêncio coordenadas fora da grade. */
    plot(row: number, col: number, char: string, className: string): void {
        const charRow = this.chars[row];
        const classRow = this.classes[row];
        if (charRow === undefined || classRow === undefined) return;
        if (col < 0 || col >= charRow.length) return;

        charRow[col] = char;
        classRow[col] = className;
    }

    /** Lê só o caractere — usado para não repintar o céu quando nada mudou. */
    charAt(row: number, col: number): string {
        return this.chars[row]?.[col] ?? BLANK_CHAR;
    }

    /**
     * Troca o caractere preservando a classe da célula. É o que o pisca-pisca
     * das estrelas precisa: a estrela muda de forma, nunca de cor.
     */
    setChar(row: number, col: number, char: string): void {
        const charRow = this.chars[row];
        if (charRow === undefined || col < 0 || col >= charRow.length) return;
        charRow[col] = char;
    }

    clear(): void {
        for (let row = 0; row < this.rowCount; row += 1) {
            this.chars[row]?.fill(BLANK_CHAR);
            this.classes[row]?.fill('');
        }
    }

    /**
     * Converte a grade em HTML, agrupando células vizinhas de mesma classe num
     * único `<span>`. Sem esse agrupamento seria um span por caractere.
     */
    toHtml(): string {
        const lines: string[] = [];
        for (let row = 0; row < this.rowCount; row += 1) {
            lines.push(this.serializeRow(row));
        }
        return lines.join('\n');
    }

    private serializeRow(row: number): string {
        const chars = this.chars[row];
        const classes = this.classes[row];
        if (chars === undefined || classes === undefined) return '';

        let html = '';
        let runClass: string | null = null;
        let runText = '';

        const flush = (): void => {
            if (runClass === null) return;
            html += runClass === '' ? runText : `<span class="${runClass}">${runText}</span>`;
        };

        for (let col = 0; col < chars.length; col += 1) {
            const className = classes[col] ?? '';
            if (className !== runClass) {
                flush();
                runClass = className;
                runText = '';
            }
            runText += chars[col] ?? BLANK_CHAR;
        }
        flush();

        return html;
    }
}
