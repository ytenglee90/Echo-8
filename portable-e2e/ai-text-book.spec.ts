import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aiTextBookScenarios } from '../e2e/helpers/ai-text-book-scenario.ts';

aiTextBookScenarios(pathToFileURL(resolve('artifacts', 'Echo-8.html')).href);
