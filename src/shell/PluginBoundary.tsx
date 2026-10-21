'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  owner: string;
  children: ReactNode;
  onError: (owner: string, error: Error, info: ErrorInfo) => void;
}

interface State {
  error?: Error;
}

export class PluginBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(this.props.owner, error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="plugin-error" role="alert">
          <strong>插件界面已隔离</strong>
          <span>{this.props.owner} 出错，其他模块仍可继续运行。</span>
        </div>
      );
    }
    return this.props.children;
  }
}
