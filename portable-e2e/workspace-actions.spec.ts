import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceActionsScenario } from '../e2e/helpers/workspace-actions-scenario.ts';

workspaceActionsScenario(pathToFileURL(resolve('artifacts/Echo-8.html')).href);
