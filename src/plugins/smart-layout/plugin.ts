import { createSmartLayoutPlugin } from './model.ts';
import { ArrangeGridActions } from './ArrangeGridActions.tsx';

export const smartLayoutPlugin = createSmartLayoutPlugin(ArrangeGridActions);
