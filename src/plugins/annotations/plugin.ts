import { createElement } from 'react';
import { AnnotationLayer } from './AnnotationLayer.tsx';
import type { ViewClient } from '../../core/contracts.ts';
import { AnnotationPopup } from './AnnotationPopup.tsx';
import { createAnnotationsPlugin } from './model.ts';

const FloatingAnnotationPopup = ({ client }: { client: ViewClient }) =>
  createElement(AnnotationPopup, { client, surface: 'floating' });
const ImmersiveAnnotationPopup = ({ client }: { client: ViewClient }) =>
  createElement(AnnotationPopup, { client, surface: 'immersive' });

export const annotationsPlugin = createAnnotationsPlugin(
  AnnotationLayer,
  FloatingAnnotationPopup,
  ImmersiveAnnotationPopup,
);
