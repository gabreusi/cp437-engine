import './styles/index.css';

import { resolveSceneElements } from './dom';
import { SceneRenderer } from './engine/renderer';
import { bindControlPanel } from './ui/controls';
import { bindExportDialog } from './ui/export';

const elements = resolveSceneElements();
const renderer = new SceneRenderer(elements);

bindControlPanel(elements.stage, renderer.rebuild);
bindExportDialog(elements.stage);

renderer.start();
