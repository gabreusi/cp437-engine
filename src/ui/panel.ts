import { type Settings, settings } from '../config';
import { requireElement } from '../dom';

type NumericKey = {
    [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

type BooleanKey = {
    [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

interface SliderSpec {
    key: NumericKey;
    label: string;
    min: number;
    max: number;
    step: number;
    /** Casas decimais no rótulo. */
    digits?: number;
    suffix?: string;
}

/**
 * Os controles são declarados aqui e o DOM é gerado a partir disto.
 *
 * A versão anterior escrevia cada slider à mão no HTML, o que dava dois lugares
 * dizendo qual era a faixa e o valor — e eles já tinham divergido. Com quinze
 * controles, gerar é a única forma de isso não voltar a acontecer.
 */
const SLIDERS: readonly SliderSpec[] = [
    { key: 'fovDegrees', label: 'Campo de visão', min: 40, max: 110, step: 1, suffix: '°' },
    { key: 'moveSpeed', label: 'Velocidade', min: 2, max: 60, step: 1 },
    { key: 'lookSensitivity', label: 'Sensibilidade', min: 0.0005, max: 0.006, step: 0.0001, digits: 4 },

    { key: 'gridSize', label: 'Grade (unidades)', min: 1, max: 16, step: 0.5, digits: 1 },
    { key: 'viewDistance', label: 'Alcance', min: 60, max: 400, step: 10 },
    { key: 'fogDensity', label: 'Névoa', min: 0, max: 2.5, step: 0.05, digits: 2 },

    { key: 'sunElevation', label: 'Elevação do sol', min: -20, max: 40, step: 0.5, digits: 1, suffix: '°' },
    { key: 'sunAzimuth', label: 'Azimute do sol', min: -180, max: 180, step: 1, suffix: '°' },
    { key: 'sunAngularSize', label: 'Tamanho do sol', min: 3, max: 30, step: 0.5, digits: 1, suffix: '°' },
    { key: 'sunSlices', label: 'Cortes no sol', min: 0.2, max: 3, step: 0.1, digits: 1 },

    { key: 'starCount', label: 'Estrelas', min: 0, max: 4000, step: 50 },

    { key: 'bloomIntensity', label: 'Bloom', min: 0, max: 2, step: 0.05, digits: 2 },
    { key: 'bloomRadius', label: 'Raio do bloom', min: 0.5, max: 6, step: 0.1, digits: 1 },
    { key: 'scanlineStrength', label: 'Scanlines', min: 0, max: 0.6, step: 0.02, digits: 2 },
    { key: 'vignetteStrength', label: 'Vinheta', min: 0, max: 1, step: 0.05, digits: 2 },
];

const TOGGLES: readonly { key: BooleanKey; label: string }[] = [
    { key: 'fogEnabled', label: 'Névoa ativa' },
];

const format = (value: number, spec: SliderSpec): string =>
    `${value.toFixed(spec.digits ?? 0)}${spec.suffix ?? ''}`;

const buildSlider = (spec: SliderSpec): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'control-group';

    const label = document.createElement('label');
    const readout = document.createElement('span');
    readout.textContent = format(settings[spec.key], spec);
    label.append(`${spec.label}: `, readout);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.value = String(settings[spec.key]);
    label.htmlFor = slider.id = `slider-${spec.key}`;

    slider.addEventListener('input', () => {
        const value = Number(slider.value);
        settings[spec.key] = value;
        readout.textContent = format(value, spec);
    });

    group.append(label, slider);
    return group;
};

const buildToggle = (spec: { key: BooleanKey; label: string }): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'switch-group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = settings[spec.key];

    const label = document.createElement('label');
    label.textContent = spec.label;
    label.htmlFor = checkbox.id = `toggle-${spec.key}`;

    checkbox.addEventListener('change', () => {
        settings[spec.key] = checkbox.checked;
    });

    group.append(label, checkbox);
    return group;
};

export const buildControlPanel = (onExport: () => void): void => {
    const content = requireElement('panel-content');

    for (const spec of SLIDERS) content.append(buildSlider(spec));
    for (const spec of TOGGLES) content.append(buildToggle(spec));

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'Exportar imagem';
    exportButton.addEventListener('click', onExport);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.id = 'btn-close-wrapper';
    closeButton.textContent = 'Fechar';

    content.append(exportButton, closeButton);

    const panel = requireElement('ui-wrapper');
    requireElement('handle').addEventListener('click', (event) => {
        event.stopPropagation();
        panel.classList.add('open');
    });
    closeButton.addEventListener('click', () => panel.classList.remove('open'));
};
