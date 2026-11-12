import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { canvasControlScenarios } from '../e2e/helpers/canvas-control-scenario.ts';
canvasControlScenarios(pathToFileURL(resolve('artifacts/Echo-8.html')).href);
