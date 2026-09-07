import { settings, type Settings } from '../config';
import { requireElement } from '../dom';

type NumericSettingKey = {
    [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

interface SliderBinding {
    id: string;
    labelId: string;
    key: NumericSettingKey;
    /** Velocidade é o único ajuste que o laço de animação já lê a cada quadro. */
    rebuilds: boolean;
}

const SLIDERS: readonly SliderBinding[] = [
    { id: 'slider-speed', labelId: 'val-speed', key: 'travelSpeed', rebuilds: false },
    { id: 'slider-density', labelId: 'val-density', key: 'starDensity', rebuilds: true },
    { id: 'slider-horizon', labelId: 'val-horizon', key: 'horizonRatio', rebuilds: true },
    { id: 'slider-sun-offset', labelId: 'val-sun-offset', key: 'sunOffsetRows', rebuilds: true },
    { id: 'slider-sun-size', labelId: 'val-sun-size', key: 'sunSizeMultiplier', rebuilds: true },
    { id: 'slider-sun-slices', labelId: 'val-sun-slices', key: 'sunSlicesMultiplier', rebuilds: true },
    { id: 'slider-grid-height', labelId: 'val-grid-height', key: 'lineSpacingWorld', rebuilds: true },
    { id: 'slider-grid-width', labelId: 'val-grid-width', key: 'railSpacingWorld', rebuilds: true },
];

/** Inteiros sem casas, frações com duas — como os rótulos sempre mostraram. */
const formatValue = (value: number): string => value.toFixed(value % 1 !== 0 ? 2 : 0);

const bindSlider = (binding: SliderBinding, onRebuild: () => void): void => {
    const slider = requireElement<HTMLInputElement>(binding.id);
    const label = requireElement(binding.labelId);

    const show = (value: number): void => {
        label.textContent = formatValue(value);
    };

    // O HTML descreve a faixa; o valor inicial vem de `settings`, então rótulo
    // e cena não têm como divergir do estado real.
    slider.value = String(settings[binding.key]);
    show(settings[binding.key]);

    slider.addEventListener('input', () => {
        const value = Number(slider.value);
        settings[binding.key] = value;
        show(value);
        if (binding.rebuilds) onRebuild();
    });
};

/** Alterna uma classe no palco conforme o checkbox — marcado significa ligado. */
const bindStageToggle = (id: string, disabledClass: string, stage: HTMLElement): void => {
    const toggle = requireElement<HTMLInputElement>(id);
    toggle.checked = true;
    toggle.addEventListener('change', () => {
        stage.classList.toggle(disabledClass, !toggle.checked);
    });
};

export const bindControlPanel = (stage: HTMLElement, onRebuild: () => void): void => {
    for (const binding of SLIDERS) {
        bindSlider(binding, onRebuild);
    }

    bindStageToggle('toggle-bg', 'no-bg', stage);
    bindStageToggle('toggle-glow', 'no-glow', stage);

    const haze = requireElement<HTMLInputElement>('toggle-haze');
    haze.checked = settings.enableHaze;
    haze.addEventListener('change', () => {
        settings.enableHaze = haze.checked;
    });

    const panel = requireElement('ui-wrapper');
    requireElement('handle').addEventListener('click', () => panel.classList.add('open'));
    requireElement('btn-close-wrapper').addEventListener('click', () => panel.classList.remove('open'));
};
