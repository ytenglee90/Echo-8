import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { instructionExperienceScenario } from '../e2e/helpers/instruction-experience-scenario.ts';
instructionExperienceScenario(pathToFileURL(path.resolve('artifacts/Echo-8.html')).href);
