import { createStatisticsPlugin } from './model.ts';
import { StatisticsStatus } from './StatisticsStatus.tsx';

export const statisticsPlugin = createStatisticsPlugin(StatisticsStatus);
