import { ConnectionLayer } from './ConnectionLayer.tsx';
import { ConnectionToolbarAction } from './ConnectionToolbarAction.tsx';
import { createConnectionsPlugin } from './model.ts';

export const connectionsPlugin = createConnectionsPlugin(ConnectionLayer, ConnectionToolbarAction);
