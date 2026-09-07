import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';

import { CANVAS_BACKGROUND } from '../config';
import { requireElement } from '../dom';

/** Renderiza acima da resolução da tela para o wallpaper aguentar telas grandes. */
const CAPTURE_SCALE = 3;

const DOWNLOAD_NAME = 'outrun-ascii-wallpaper.png';

/** Aguarda a imagem estar decodificada: o Cropper mede o elemento ao nascer. */
const waitForImage = (image: HTMLImageElement): Promise<void> =>
    new Promise((resolve) => {
        if (image.complete && image.naturalWidth > 0) {
            resolve();
            return;
        }
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => resolve(), { once: true });
    });

/** Lê um campo de dimensão, tratando vazio e lixo como "manter o recorte". */
const readDimension = (input: HTMLInputElement): number | undefined => {
    const parsed = Number.parseInt(input.value, 10);
    return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
};

export type CaptureFn = (scale: number) => HTMLCanvasElement;

/**
 * Captura a cena, deixa o usuário recortar e baixa o PNG.
 *
 * A captura não vem mais do html2canvas, que não enxerga canvas WebGL: quem
 * entrega o quadro é o presenter, renderizando de novo fora da tela em
 * resolução ampliada. O Cropper continua igual — ele trabalha sobre uma imagem.
 */
class ExportDialog {
    private cropper: Cropper | null = null;

    private readonly modal = requireElement('export-modal');
    private readonly image = requireElement<HTMLImageElement>('crop-image');
    private readonly widthInput = requireElement<HTMLInputElement>('export-width');
    private readonly heightInput = requireElement<HTMLInputElement>('export-height');

    constructor(private readonly capture: CaptureFn) {}

    bind(): void {
        requireElement('btn-download').addEventListener('click', () => this.download());
        requireElement('btn-cancel').addEventListener('click', () => this.close());
    }

    async open(): Promise<void> {
        this.image.src = this.capture(CAPTURE_SCALE).toDataURL('image/png');
        this.modal.classList.add('open');
        await waitForImage(this.image);

        this.cropper?.destroy();
        this.cropper = new Cropper(this.image, {
            viewMode: 1,
            background: false,
            zoomable: true,
        });
    }

    private download(): void {
        if (this.cropper === null) return;

        const width = readDimension(this.widthInput);
        const height = readDimension(this.heightInput);

        const cropped = this.cropper.getCroppedCanvas({
            fillColor: CANVAS_BACKGROUND,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high',
            ...(width !== undefined && { width }),
            ...(height !== undefined && { height }),
        });

        const link = document.createElement('a');
        link.download = DOWNLOAD_NAME;
        link.href = cropped.toDataURL('image/png', 1);
        link.click();

        this.close();
    }

    private close(): void {
        this.modal.classList.remove('open');
        this.cropper?.destroy();
        this.cropper = null;
    }
}

export const createExportDialog = (capture: CaptureFn): (() => void) => {
    const dialog = new ExportDialog(capture);
    dialog.bind();
    return () => void dialog.open();
};
